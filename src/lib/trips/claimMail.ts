import { fromZonedTime } from "date-fns-tz";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { attachments, claims, trips, type ClaimRow, type TripRow } from "@/db/schema";
import { createTrip, saveAttachment, saveClaim, updateTrip } from "./repo";

/**
 * Mail from DB's passenger-rights service:
 *  - "Fahrgastrechteantrag Eingangsbestätigung <Fall-ID>" (HTML): what was
 *    claimed, for which order and journey → claim "submitted".
 *  - "Ihr Fahrgastrechteantrag – <Fall-ID> – …" with "Auszahlung-…pdf" /
 *    "Ablehnung-…pdf": the decision → claim "paid" (amount) or "rejected"
 *    (reason).
 * Claims are matched by case id, else by order number; a journey that isn't
 * in the calendar yet is created from the claim's data.
 */

const TZ = "Europe/Berlin";
const flat = (t: string) => t.replace(/\s+/g, " ").trim();
const ymd = (d: string) => `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;
const euro = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));
const berlin = (date: string, time: string) => fromZonedTime(`${ymd(date)}T${time.padStart(5, "0")}:00`, TZ).toISOString();
/** yyyy-MM-dd → epoch ms (noon Berlin, so the calendar day is stable). */
const dayMs = (isoDay: string) => fromZonedTime(`${isoDay}T12:00:00`, TZ).getTime();

export interface ClaimConfirmation {
  caseId: string;
  orderNumber: string | null;
  from: string | null;
  to: string | null;
  departure: string | null; // ISO
  arrival: string | null;
  problem: string | null;
  abortedAt: string | null;
  payout: "transfer" | "voucher" | null;
}

export function parseClaimConfirmation(text: string): ClaimConfirmation | null {
  const t = flat(text);
  const caseId = /Fall-ID\s+([A-Z0-9]{6,})/.exec(t)?.[1];
  if (!caseId) return null;
  const start = /Start:\s*(.{1,150}?)\s*,\s*(\d{2}\.\d{2}\.\d{4}),\s*(\d{1,2}:\d{2})\s*Uhr/.exec(t);
  const ziel = /Ziel:\s*(.{1,150}?)\s*,\s*(\d{2}\.\d{2}\.\d{4}),\s*(\d{1,2}:\d{2})\s*Uhr/.exec(t);
  const problem = /Problem:\s*(.+?)\s*(?:Folgende|Persönliche Angaben|$)/.exec(t)?.[1]?.trim() ?? null;
  const pay = /Auszahlung via:\s*(Überweisung|Gutschein)/.exec(t)?.[1];
  return {
    caseId,
    orderNumber: /Auftragsnummer\s+(\d{6,})/.exec(t)?.[1] ?? null,
    from: start?.[1] ?? null,
    to: ziel?.[1] ?? null,
    departure: start ? berlin(start[2], start[3]) : null,
    arrival: ziel ? berlin(ziel[2], ziel[3]) : null,
    problem,
    abortedAt: problem ? (/Fahrtabbruch unterwegs \((.+)\)$/.exec(problem)?.[1] ?? null) : null,
    payout: pay === "Gutschein" ? "voucher" : pay ? "transfer" : null,
  };
}

export interface ClaimDecision {
  caseId: string;
  orderNumber: string | null;
  travelDate: string | null; // yyyy-MM-dd
  submittedDate: string | null; // "Ihr Anliegen vom"
  decidedDate: string | null;
  from: string | null;
  to: string | null;
  paid: boolean;
  amount: number;
  delayMin: number | null;
  /** Ticket value DB used ("Fahrtwert/Belegwert" of the first item). */
  ticketValue: number | null;
  /** "Fahrtabbruch", "Verspätung unter 60 min", … */
  items: string[];
  reason: string | null;
}

export function parseClaimDecision(text: string): ClaimDecision | null {
  const caseId = /Fall-ID\s+([A-Z0-9]{6,})/.exec(text)?.[1];
  if (!caseId) return null;
  const t = flat(text);
  const amount = /den Betrag von ([\d.]+,\d{2}) Euro/.exec(t)?.[1];
  const route = /Fahrt von (.+?) nach (.+?) entschuldigen/.exec(t);
  const reason = /Gründe für unsere Entscheidung\.\s*(.+?)\s*Wenn Sie weitere Fragen/.exec(t)?.[1] ?? null;
  const items = [...(reason ?? "").matchAll(/\d+\.\s*([^:]{3,60}):/g)].map((m) => m[1].trim());
  const travel = /Ihre Reise am (\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1];
  const submitted = /Ihr Anliegen vom (\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1];
  const decided = /(\d{2}\.\d{2}\.\d{4})\s*\n\s*Ihr Anliegen vom/.exec(text)?.[1];
  return {
    caseId,
    orderNumber: /Auftragsnummer:\s*(\d{6,})/.exec(t)?.[1] ?? null,
    travelDate: travel ? ymd(travel) : null,
    submittedDate: submitted ? ymd(submitted) : null,
    decidedDate: decided ? ymd(decided) : null,
    from: route?.[1]?.trim() ?? null,
    to: route?.[2]?.trim() ?? null,
    paid: !!amount && euro(amount) > 0,
    amount: amount ? euro(amount) : 0,
    delayMin: Number(/mit (\d+) min Verspätung am Zielort/.exec(t)?.[1]) || null,
    ticketValue: (() => {
      const row = /^\s*1\.\s.*?([\d.]+,\d{2}) Euro\s+([\d.]+,\d{2}) Euro/m.exec(text);
      return row ? euro(row[1]) : null;
    })(),
    items,
    reason: reason ? reason.slice(0, 1500) : null,
  };
}

/** Problem text → our trip status and the claim type. */
function classify(problem: string | null | undefined): { status: string; type: string } {
  const p = (problem ?? "").toLowerCase();
  if (p.includes("abbruch") || p.includes("abgebrochen")) return { status: "aborted", type: "aborted_return" };
  if (p.includes("nicht angetreten") || p.includes("nichtantritt")) return { status: "not_started", type: "not_started" };
  if (p.includes("ausfall")) return { status: "cancelled", type: "not_started" };
  return { status: "delayed", type: "delay" };
}

function findClaim(caseId: string, orderNumber: string | null, date: string | null): { claim: ClaimRow | null; trip: TripRow | null } {
  const byCase = db.select().from(claims).where(eq(claims.caseId, caseId)).get();
  if (byCase) return { claim: byCase, trip: db.select().from(trips).where(eq(trips.id, byCase.tripId)).get() ?? null };
  // Round trips share one order number → prefer the trip on the travel date.
  const candidates = orderNumber ? db.select().from(trips).where(eq(trips.orderNumber, orderNumber)).all() : [];
  // With a known travel date only that day's trip counts (the return of a
  // round trip is a different trip); no date → any trip of the order.
  let trip = (date ? candidates.find((t) => t.date === date) : candidates[0]) ?? null;
  // Ticket used another day: the claim is about the journey actually made.
  if (trip?.status === "moved") trip = db.select().from(trips).where(eq(trips.movedFrom, trip.id)).get() ?? trip;
  // A claim created in the app (form) but not yet linked to a case id.
  const open = trip
    ? (db
        .select()
        .from(claims)
        .where(and(eq(claims.tripId, trip.id), isNull(claims.caseId)))
        .orderBy(desc(claims.createdAt))
        .get() ?? null)
    : null;
  return { claim: open, trip };
}

function ensureTrip(
  trip: TripRow | null,
  info: { orderNumber: string | null; date: string | null; from: string | null; to: string | null; departure?: string | null; arrival?: string | null; problem?: string | null; abortedAt?: string | null },
): TripRow | null {
  if (trip) return trip;
  if (!info.date && !info.departure) return null;
  const c = classify(info.problem);
  const created = createTrip({
    date: info.date ?? undefined,
    source: "claim",
    orderNumber: info.orderNumber,
    legs: [
      {
        fromName: info.from ?? "?",
        toName: info.to ?? "?",
        plannedDeparture: info.departure ?? null,
        plannedArrival: info.arrival ?? null,
      },
    ],
    notes: info.problem ? `Aus Fahrgastrechte-Antrag: ${info.problem}` : "Aus Fahrgastrechte-Antrag",
  });
  return updateTrip(created.id, { status: c.status, abortedAt: info.abortedAt ?? null });
}

/** A known trip learns from the claim what happened (only if nobody said so yet),
 *  and a trip created from a decision letter gets the times from the receipt. */
function enrichTrip(
  trip: TripRow,
  info: { problem?: string | null; abortedAt?: string | null; from?: string | null; to?: string | null; departure?: string | null; arrival?: string | null },
  fromReceipt = false,
): TripRow {
  const patch: Parameters<typeof updateTrip>[1] = {};
  // The receipt states what the user claimed → it may correct a status that an
  // earlier decision letter guessed for a trip created from it.
  const mayCorrect = trip.status === "planned" || (fromReceipt && trip.source === "claim");
  if (mayCorrect && info.problem) patch.status = classify(info.problem).status;
  if (!trip.abortedAt && info.abortedAt) patch.abortedAt = info.abortedAt;
  const onlyLeg = trip.legs.length === 1 ? trip.legs[0] : null;
  if (trip.source === "claim" && onlyLeg && !onlyLeg.plannedDeparture && info.departure)
    patch.legs = [{ ...onlyLeg, fromName: info.from ?? onlyLeg.fromName, toName: info.to ?? onlyLeg.toName, plannedDeparture: info.departure, plannedArrival: info.arrival ?? null }];
  if (trip.source === "claim" && info.problem && !(trip.notes ?? "").includes(info.problem))
    patch.notes = `Aus Fahrgastrechte-Antrag: ${info.problem}`;
  return Object.keys(patch).length ? (updateTrip(trip.id, patch) ?? trip) : trip;
}

export interface ClaimMailResult {
  kind: "confirmation" | "decision";
  caseId: string;
  claim: ClaimRow;
  trip: TripRow;
  tripCreated: boolean;
}

export function applyConfirmation(c: ClaimConfirmation, receivedAt: number): ClaimMailResult | null {
  const date = c.departure ? new Date(c.departure).toLocaleDateString("sv-SE", { timeZone: TZ }) : null;
  const found = findClaim(c.caseId, c.orderNumber, date);
  const info = { from: c.from, to: c.to, departure: c.departure, arrival: c.arrival, problem: c.problem, abortedAt: c.abortedAt };
  const known = ensureTrip(found.trip, { orderNumber: c.orderNumber, date, ...info });
  if (!known) return null;
  const trip = enrichTrip(known, info, true);
  const k = classify(c.problem);
  const decided = found.claim && (found.claim.status === "paid" || found.claim.status === "rejected");
  const claim = saveClaim(trip.id, {
    id: found.claim?.id,
    caseId: c.caseId,
    // The receipt states what was claimed — more precise than a decision's first item.
    type: c.problem ? k.type : (found.claim?.type ?? k.type),
    status: decided ? found.claim!.status : "submitted",
    // The receipt's own timestamp is the exact submission time.
    submittedAt: receivedAt,
    payout: c.payout ?? found.claim?.payout ?? "transfer",
    notes: c.problem ?? found.claim?.notes ?? null,
  });
  return { kind: "confirmation", caseId: c.caseId, claim, trip, tripCreated: !found.trip };
}

export function applyDecision(d: ClaimDecision, pdf?: { name: string; bytes: Buffer }): ClaimMailResult | null {
  const found = findClaim(d.caseId, d.orderNumber, d.travelDate);
  const known = ensureTrip(found.trip, { orderNumber: d.orderNumber, date: d.travelDate, from: d.from, to: d.to, problem: d.items[0] ?? null });
  if (!known) return null;
  const trip = enrichTrip(known, { problem: d.items[0] ?? null });
  if (trip.price == null && d.ticketValue != null) updateTrip(trip.id, { price: d.ticketValue });
  const claim = saveClaim(trip.id, {
    id: found.claim?.id,
    caseId: d.caseId,
    type: found.claim?.type ?? classify(d.items[0]).type,
    status: d.paid ? "paid" : "rejected",
    submittedAt: found.claim?.submittedAt ?? (d.submittedDate ? dayMs(d.submittedDate) : null),
    decidedAt: d.decidedDate ? dayMs(d.decidedDate) : Date.now(),
    paidAt: d.paid ? (d.decidedDate ? dayMs(d.decidedDate) : Date.now()) : null,
    paidAmount: d.amount,
    delayMin: d.delayMin ?? found.claim?.delayMin ?? null,
    reason: d.reason,
  });
  if (pdf) {
    const have = db
      .select()
      .from(attachments)
      .where(and(eq(attachments.tripId, trip.id), eq(attachments.kind, "decision"), eq(attachments.size, pdf.bytes.length)))
      .get();
    if (!have) saveAttachment(trip.id, { name: pdf.name, type: "application/pdf", bytes: pdf.bytes }, "decision", d.paid ? "Bescheid: Auszahlung" : "Bescheid: Ablehnung");
  }
  return { kind: "decision", caseId: d.caseId, claim, trip, tripCreated: !found.trip };
}
