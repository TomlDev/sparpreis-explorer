import { and, eq, isNull } from "drizzle-orm";
import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import { extractText, getDocumentProxy } from "unpdf";
import { db } from "@/db/client";
import { attachments, trips, type TripRow } from "@/db/schema";
import { applyConfirmation, applyDecision, parseClaimConfirmation, parseClaimDecision, type ClaimMailResult } from "./claimMail";
import { htmlToText, parseBookingHtml, parseIcs, parseTicketText, type ParsedBooking, type ParsedJourney } from "./importDb";
import { createTrip, dayOf, mergeClaimDuplicates, saveAttachment, updateTrip } from "./repo";
import { applyBahnCardCancellation, parseBahnCardCancellation, parseBahnCardOrder, parseBahnCardService, parsePoints, parsePromo, saveBahnCard, savePoints, savePromo } from "./loyalty";
import { applyPendingScheduleChanges, applyScheduleChange, parseScheduleChange, parseVoucher, rememberScheduleChange, saveVoucher } from "./serviceMail";

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

const MAX_TEXT = 200_000;

async function pdfText(bytes: Buffer): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  // DB tickets and letters have 1–3 pages — don't spend time on anything else.
  if (doc.numPages > 6) throw new Error("PDF hat zu viele Seiten für ein DB-Ticket.");
  const { text } = await extractText(doc, { mergePages: true });
  return (Array.isArray(text) ? text.join("\n") : text).slice(0, MAX_TEXT);
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
/** "-------- Weitergeleitete Nachricht -------- … Datum: Sat, 12 Sep 2026 14:03:57 +0000" */
/** The mail carries a valid DKIM signature of Deutsche Bahn (checked against
 *  DNS here — never trust Authentication-Results headers inside the mail). */
export async function signedByDb(raw: Buffer): Promise<boolean> {
  try {
    const r = (await authenticate(raw, { trustReceived: false, disableArc: true, disableBimi: true, disableDmarc: true } as never)) as {
      dkim?: { results?: { signingDomain?: string; status?: { result?: string } }[] };
    };
    return (r.dkim?.results ?? []).some((x) => x.status?.result === "pass" && /(^|\.)(bahn\.de|deutschebahn\.com)$/i.test(x.signingDomain ?? ""));
  } catch {
    return false;
  }
}

/** Text right after the "forwarded message" marker (bounded → no regex blow-up). */
function forwardHeader(body: string): string | null {
  const i = body.search(/Weitergeleitete Nachricht|Forwarded message|Ursprüngliche Nachricht/i);
  return i < 0 ? null : body.slice(i, i + 700);
}

export function originalDate(body: string): Date | null {
  const head = forwardHeader(body);
  const m = head && /(?:Datum|Date|Gesendet):[ \t]*([^\n]{6,90}?)(?=[ \t]+(?:Von|From|An|To|Betreff|Subject):|\n|$)/i.exec(head);
  if (!m) return null;
  const raw = m[1]
    .replace(/\s*\(UTC\)/, "")
    .replace(/^\w+,\s*/, "")
    .replace(/\s+(?:at|um)\s+/i, " "); // Gmail: "Sep 12, 2026 at 4:03 PM"
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sender of the original mail in a forwarded one ("Von: BahnBonus <info@…>"). */
export function originalSender(body: string): string | null {
  const head = forwardHeader(body);
  const m = head && /(?:Von|From):[^\n@]{0,120}?(?<![\w.+-])([\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8})/i.exec(head);
  return m?.[1] ?? null;
}

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

export async function importDocument(file: ImportFile, source = "import", depth = 0): Promise<ImportResult> {
  const warnings: string[] = [];
  let booking: ParsedBooking | null = null;
  let icsJourneys: ParsedJourney[] = [];
  let html: ReturnType<typeof parseBookingHtml> | null = null;
  const pdfs: ImportFile[] = [];

  if (isEml(file)) {
    const mail = await simpleParser(file.bytes);

    // Forwarded "as attachment": the original DB mail is inside — handle that
    // one (any kind: booking, claim, schedule change, …) instead of the wrapper.
    const inner = depth < 2 ? mail.attachments.filter((a) => a.contentType === "message/rfc822").slice(0, 10) : [];
    if (inner.length) {
      const merged: ImportResult = { created: [], updated: [], warnings: [], claims: [] };
      const skipped: string[] = [];
      for (const a of inner) {
        try {
          const r = await importDocument({ name: a.filename ?? "weitergeleitet.eml", type: "message/rfc822", bytes: a.content }, source, depth + 1);
          merged.created.push(...r.created);
          merged.updated.push(...r.updated);
          merged.warnings.push(...r.warnings);
          merged.claims!.push(...(r.claims ?? []));
          if (r.skipped) skipped.push(r.skipped);
        } catch (e) {
          merged.warnings.push((e as Error).message);
        }
      }
      if (skipped.length) merged.skipped = skipped.join(" · ");
      if (merged.created.length || merged.updated.length || merged.claims!.length || merged.skipped) return merged;
    }
    const subject = (mail.subject ?? "").slice(0, 500);
    // Bounded input: DB mails are small; huge bodies are cut before any parsing.
    const body = (mail.html ? htmlToText(mail.html.slice(0, 1_000_000)) : (mail.text ?? "")).slice(0, MAX_TEXT);
    // Forwarded mails carry the original date in the quoted header block.
    const sentAt = originalDate(body) ?? mail.date ?? new Date();

    // Passenger-rights service: receipt confirmation / decision letter.
    if (/Fahrgastrechte/i.test(subject)) {
      const res: ImportResult = { created: [], updated: [], warnings, claims: [] };
      const conf = /Eingangsbest[äa]tigung/i.test(subject) ? parseClaimConfirmation(body) : null;
      if (conf) {
        const r = applyConfirmation(conf, sentAt.getTime());
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
    const change = parseScheduleChange(subject, body);
    if (change) {
      const trip = applyScheduleChange(change, sentAt);
      if (!trip) {
        // The booking may arrive later (e.g. old mails forwarded in any order).
        rememberScheduleChange(change, sentAt);
        return { created: [], updated: [], warnings, skipped: `Fahrplanänderung ${change.date ?? ""} gemerkt – wird zugeordnet, sobald die Buchung da ist` };
      }
      return { created: [], updated: [trip], warnings };
    }
    const voucher = parseVoucher(subject, body);
    if (voucher) {
      saveVoucher(voucher, sentAt);
      return { created: [], updated: [], warnings, skipped: `Gutschein ${voucher.number} (${voucher.value.toFixed(2).replace(".", ",")} €) gespeichert` };
    }
    const cancel = parseBahnCardCancellation(subject, body);
    if (cancel) {
      // Money-relevant (it removes the "cancel by" reminder) → only from a mail
      // that is provably from DB, not from an arbitrary (forwarded/spoofed) one.
      if (!(await signedByDb(file.bytes)))
        return { created: [], updated: [], warnings, skipped: "BahnCard-Kündigung nicht verifizierbar (keine DB-Signatur) – bitte in der App von Hand eintragen" };
      const card = applyBahnCardCancellation(cancel);
      return { created: [], updated: [], warnings, skipped: card ? `${card.product} gekündigt zum ${cancel.until}` : "BahnCard-Kündigung – passende BahnCard nicht gefunden" };
    }
    // BahnCard: order ("Buchungsbestätigung" without a journey) / BahnCard service mail.
    const hasJourney = mail.attachments.some((a) => isIcs({ name: a.filename, type: a.contentType }));
    const bcOrder = !hasJourney ? parseBahnCardOrder(body) : null;
    const bcService = parseBahnCardService(subject, body);
    if (bcOrder || bcService) {
      const card = saveBahnCard({ ...bcService, ...bcOrder }, sentAt);
      return { created: [], updated: [], warnings, skipped: `${card.product} gespeichert${card.validUntil ? ` (bis ${card.validUntil}, bitte prüfen)` : ""}` };
    }
    // BahnBonus: points overview; other BahnBonus/marketing mail → promotions list.
    const points = parsePoints(body);
    if (points) savePoints(points);
    const sender = originalSender(body) ?? mail.from?.value?.[0]?.address ?? "";
    if (points || (/bahncard\.bahn\.de|newsletter/i.test(sender) && !hasJourney && !mail.attachments.some((a) => isPdf({ name: a.filename, type: a.contentType })))) {
      savePromo(parsePromo(subject, body, sentAt));
      return { created: [], updated: [], warnings, skipped: points ? `BahnBonus: ${points.praemien} Prämienpunkte (Stand ${points.asOf})` : "Aktion/Newsletter gespeichert" };
    }
    if (mail.html) html = parseBookingHtml(mail.html.slice(0, 1_000_000));
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

  // Itinerary: .ics (has walks + platforms) beats the PDF table; the PDF
  // adds seat reservations per train.
  const journeys = icsJourneys.length ? icsJourneys : (booking?.journeys ?? []);
  if (icsJourneys.length && booking?.journeys.length) {
    const seats = new Map(booking.journeys.flatMap((j) => j.legs).filter((l) => l.reservation).map((l) => [`${l.lineName}|${l.plannedDeparture}`, l.reservation]));
    for (const l of journeys.flatMap((j) => j.legs)) l.reservation ??= seats.get(`${l.lineName}|${l.plannedDeparture}`) ?? null;
  }
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
    // A trip created from a passenger-rights mail has no direction yet.
    const fromClaim =
      !byOrder && orderNumber && date
        ? db
            .select()
            .from(trips)
            .where(and(eq(trips.orderNumber, orderNumber), isNull(trips.direction), eq(trips.date, date)))
            .get()
        : null;
    // Without an order number (e.g. a bare .ics): same day + same first train
    // at the same time is the same booking.
    // (Only without an order number — the same connection can be booked twice.)
    const sameTrain = !orderNumber && date ? sameConnection(date, j) : null;
    const existing = byOrder ?? fromClaim ?? sameTrain;
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
        // A reservation-only document has no fare (the 11 € were the seat fee).
        price: ticket?.reservationOnly ? null : keep(fields.price, existing.price),
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
  mergeClaimDuplicates();
  applyPendingScheduleChanges();
  return result;
}
