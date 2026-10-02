import { and, eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import { extractText, getDocumentProxy } from "unpdf";
import { db } from "@/db/client";
import { attachments, trips, type TripRow } from "@/db/schema";
import { applyConfirmation, applyDecision, parseClaimConfirmation, parseClaimDecision, type ClaimMailResult } from "./claimMail";
import { htmlToText, parseBookingHtml, parseIcs, parseTicketText, type ParsedBooking, type ParsedJourney } from "./importDb";
import { createTrip, dayOf, saveAttachment, updateTrip } from "./repo";

export interface ImportFile {
  name: string;
  type: string;
  bytes: Buffer;
}

export interface ImportResult {
  created: TripRow[];
  updated: TripRow[];
  warnings: string[];
  /** Passenger-rights mails that updated a claim. */
  claims?: ClaimMailResult[];
  /** Recognised, but nothing to import (e.g. a BahnCard order). */
  skipped?: string;
}

async function pdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

const isPdf = (f: { name?: string | null; type?: string }) => f.type === "application/pdf" || /\.pdf$/i.test(f.name ?? "");
const isIcs = (f: { name?: string | null; type?: string }) => f.type === "text/calendar" || /\.ics$/i.test(f.name ?? "");
const isEml = (f: { name?: string | null; type?: string }) => f.type === "message/rfc822" || /\.eml$/i.test(f.name ?? "");

/**
 * Import a DB booking: a booking mail (.eml), a ticket PDF or a calendar
 * file (.ics). A booking that is already known (same order number and
 * direction) is updated instead of duplicated; trips keep their status,
 * checks and photos.
 */
const firstTrain = (legs: TripRow["legs"]) => legs.find((l) => !l.isWalking && l.lineName);

function sameConnection(date: string, j: ParsedJourney): TripRow | null {
  const a = firstTrain(j.legs);
  if (!a?.plannedDeparture) return null;
  const at = new Date(a.plannedDeparture).getTime();
  return (
    db
      .select()
      .from(trips)
      .where(eq(trips.date, date))
      .all()
      .find((t) => {
        const b = firstTrain(t.legs);
        return !!b?.plannedDeparture && b.lineName === a.lineName && new Date(b.plannedDeparture).getTime() === at;
      }) ?? null
  );
}

export async function importDocument(file: ImportFile, source = "import"): Promise<ImportResult> {
  const warnings: string[] = [];
  let booking: ParsedBooking | null = null;
  let icsJourneys: ParsedJourney[] = [];
  let html: ReturnType<typeof parseBookingHtml> | null = null;
  const pdfs: ImportFile[] = [];

  if (isEml(file)) {
    const mail = await simpleParser(file.bytes);
    const subject = mail.subject ?? "";
    const body = mail.html ? htmlToText(mail.html) : (mail.text ?? "");

    // Passenger-rights service: receipt confirmation / decision letter.
    if (/Fahrgastrechte/i.test(subject)) {
      const res: ImportResult = { created: [], updated: [], warnings, claims: [] };
      const conf = /Eingangsbest[äa]tigung/i.test(subject) ? parseClaimConfirmation(body) : null;
      if (conf) {
        const r = applyConfirmation(conf, (mail.date ?? new Date()).getTime());
        if (r) res.claims!.push(r);
      }
      for (const a of mail.attachments.filter((a) => isPdf({ name: a.filename, type: a.contentType }))) {
        const d = parseClaimDecision(await pdfText(a.content));
        const r = d ? applyDecision(d, { name: a.filename ?? `Bescheid-${d.caseId}.pdf`, bytes: a.content }) : null;
        if (r) res.claims!.push(r);
      }
      for (const r of res.claims!) (r.tripCreated ? res.created : res.updated).push(r.trip);
      if (!res.claims!.length) throw new Error("Fahrgastrechte-Mail nicht erkannt.");
      return res;
    }
    // BahnCard orders also arrive as "Buchungsbestätigung" — no journey in them.
    if (/BahnCard-Bestellung|Produkt:\s*BahnCard/i.test(body) && !mail.attachments.some((a) => isIcs({ name: a.filename, type: a.contentType }))) {
      const product = /Produkt:\s*([^\n]+)/.exec(body)?.[1]?.trim() ?? "BahnCard";
      return { created: [], updated: [], warnings, skipped: `BahnCard-Bestellung (${product}) – keine Fahrt` };
    }
    // Forwarded "as attachment": the original DB mail is inside.
    const inner = mail.attachments.filter((a) => a.contentType === "message/rfc822");
    if (inner.length) {
      const merged: ImportResult = { created: [], updated: [], warnings: [] };
      for (const a of inner) {
        try {
          const r = await importDocument({ name: a.filename ?? "weitergeleitet.eml", type: "message/rfc822", bytes: a.content }, source);
          merged.created.push(...r.created);
          merged.updated.push(...r.updated);
          merged.warnings.push(...r.warnings);
        } catch (e) {
          merged.warnings.push((e as Error).message);
        }
      }
      if (merged.created.length || merged.updated.length) return merged;
    }
    if (mail.html) html = parseBookingHtml(mail.html);
    for (const a of mail.attachments) {
      if (isIcs({ name: a.filename, type: a.contentType })) icsJourneys.push(...parseIcs(a.content.toString("utf8"), a.filename ?? ""));
      if (isPdf({ name: a.filename, type: a.contentType }))
        pdfs.push({ name: a.filename ?? "Ticket.pdf", type: "application/pdf", bytes: a.content });
    }
  } else if (isPdf(file)) pdfs.push(file);
  else if (isIcs(file)) icsJourneys = parseIcs(file.bytes.toString("utf8"), file.name);
  else throw new Error("Bitte eine DB-Buchungsmail (.eml), ein Ticket-PDF oder eine .ics-Datei wählen.");

  for (const p of pdfs) {
    const parsed = parseTicketText(await pdfText(p.bytes));
    if (parsed.orderNumber || parsed.journeys.length) {
      booking = parsed;
      break;
    }
  }
  if (pdfs.length && !booking) warnings.push("Ticket-PDF nicht erkannt – Preis/Tarif fehlen evtl.");

  // Itinerary: .ics (has walks + platforms) beats the PDF table.
  const journeys = icsJourneys.length ? icsJourneys : (booking?.journeys ?? []);
  if (!journeys.length) throw new Error("Keine Verbindung in der Datei gefunden.");
  if (journeys.length === 1 && !journeys[0].direction) journeys[0].direction = "outbound";

  const orderNumber = booking?.orderNumber ?? html?.orderNumber ?? null;
  const price = booking?.price ?? html?.price ?? null;
  const klasse = booking?.klasse ?? html?.klasse ?? null;
  const ticket = booking?.ticket ?? (html?.tariff ? { tariff: html.tariff } : null);
  const roundTrip = booking?.roundTrip ?? journeys.length > 1;

  const result: ImportResult = { created: [], updated: [], warnings };
  for (const j of journeys) {
    const date = dayOf(j.legs.find((l) => l.plannedDeparture)?.plannedDeparture);
    const byOrder = orderNumber
      ? db
          .select()
          .from(trips)
          .where(and(eq(trips.orderNumber, orderNumber), eq(trips.direction, j.direction ?? "outbound")))
          .get()
      : null;
    // Without an order number (e.g. a bare .ics): same day + same first train
    // at the same time is the same booking.
    const existing = byOrder ?? (date ? sameConnection(date, j) : null);
    const fields = {
      orderNumber,
      price,
      klasse,
      ticketType: ticket?.tariff ?? null,
      direction: j.direction ?? "outbound",
      roundTrip,
    };
    let trip: TripRow;
    if (existing) {
      // Never downgrade: the .ics itinerary (with walks) beats the PDF table,
      // and a missing value never overwrites a known one.
      const keep = <T,>(v: T | null | undefined, old: T | null) => (v ?? old) as T | null;
      trip = updateTrip(existing.id, {
        orderNumber: keep(fields.orderNumber, existing.orderNumber),
        price: keep(fields.price, existing.price),
        klasse: keep(fields.klasse, existing.klasse),
        ticketType: keep(fields.ticketType, existing.ticketType),
        direction: fields.direction,
        roundTrip: fields.roundTrip || existing.roundTrip,
        ticket: ticket ? { ...(existing.ticket ?? {}), ...ticket } : existing.ticket,
        ...(j.legs.length >= existing.legs.length ? { legs: j.legs } : {}),
      })!;
      result.updated.push(trip);
    } else {
      trip = createTrip({ ...fields, legs: j.legs, date: date ?? undefined, source, ticket });
      result.created.push(trip);
    }
    // Keep the ticket PDF with the trip (once).
    for (const p of pdfs) {
      const have = db
        .select()
        .from(attachments)
        .where(and(eq(attachments.tripId, trip.id), eq(attachments.kind, "ticket"), eq(attachments.size, p.bytes.length)))
        .get();
      if (!have) saveAttachment(trip.id, p, "ticket", "Ticket");
    }
  }
  return result;
}
