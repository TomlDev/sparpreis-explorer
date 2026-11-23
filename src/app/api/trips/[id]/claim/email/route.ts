import fs from "node:fs";
import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { CLAIM_MAIL_TO, sendClaimMail } from "@/lib/trips/claimSend";
import { getProfile } from "@/lib/trips/profile";
import { getAttachment, getTrip, saveClaim } from "@/lib/trips/repo";
import { ticketSpan } from "@/lib/trips/rules";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const PROBLEM: Record<string, string> = {
  delay: "Verspätung am Ziel",
  not_started: "Fahrt wegen Verspätung nicht angetreten",
  aborted_return: "Fahrt unterwegs abgebrochen",
  continued_extra: "Weiterfahrt mit Zusatzkosten",
};
const de = (d: string) => d.split("-").reverse().join(".");

/** { confirm: true } — the generated form (unsent draft) by e-mail to DB's passenger-rights service. */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const trip = getTrip((await params).id);
  if (!trip) return NextResponse.json({ error: "Fahrt nicht gefunden" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.confirm !== true) return NextResponse.json({ error: "Bestätigung fehlt" }, { status: 400 });
  const draft = trip.claims.find((c) => c.status === "draft" && !c.caseId);
  const attId = draft?.notes ? /Formular erzeugt \((att_[^)]+)\)/.exec(draft.notes)?.[1] : undefined;
  const att = attId ? getAttachment(attId) : null;
  if (!draft || !att || !fs.existsSync(att.abs)) return NextResponse.json({ error: "Erst das Formular erstellen." }, { status: 400 });
  const p = getProfile();
  if (!p.email) return NextResponse.json({ error: "In den Einstellungen fehlt deine E-Mail-Adresse (für die Antwort der DB)." }, { status: 400 });

  const span = ticketSpan(trip);
  const problem = PROBLEM[draft.type] ?? "Fahrgastrechte";
  const where = draft.type === "aborted_return" && trip.abortedAt ? ` in ${trip.abortedAt}` : "";
  const name = `${p.firstName} ${p.lastName}`.trim();
  const order = trip.orderNumber ? `, Auftrag ${trip.orderNumber}` : "";
  try {
    const sent = await sendClaimMail({
      subject: `Fahrgastrechte: Antrag ${problem} – ${de(trip.date)}${order}`,
      text: [
        "Sehr geehrte Damen und Herren,",
        "",
        `anbei mein ausgefülltes und unterschriebenes Fahrgastrechte-Formular zur Fahrt am ${de(trip.date)} (${span.from} → ${span.to}${order}): ${problem}${where}.`,
        "",
        `Bitte antworten Sie an ${p.email}.`,
        "",
        "Mit freundlichen Grüßen",
        name,
      ].join("\n"),
      pdf: { name: att.filename, bytes: fs.readFileSync(att.abs) },
      replyTo: p.email,
      fromName: name,
    });
    const claim = saveClaim(trip.id, {
      id: draft.id,
      status: "submitted",
      submittedAt: Date.now(),
      notes: `${draft.notes} · Per E-Mail an ${CLAIM_MAIL_TO} gesendet (Kopie an dich, ${sent.messageId}).`,
    });
    return NextResponse.json({ claim, to: CLAIM_MAIL_TO });
  } catch (e) {
    return NextResponse.json({ error: `Senden fehlgeschlagen: ${(e as Error).message}` }, { status: 502 });
  }
}
