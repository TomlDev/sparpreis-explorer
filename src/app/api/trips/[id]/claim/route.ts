import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { fillClaimForm, FORM_ADDRESS } from "@/lib/trips/claimForm";
import { getProfile, ibanValid } from "@/lib/trips/profile";
import { deleteAttachment, getTrip, saveAttachment, saveClaim } from "@/lib/trips/repo";
import { getSignature } from "@/lib/trips/signature";
import { arrivalDelayMin, assess, ticketSpan, type FormJourney } from "@/lib/trips/rules";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const JOURNEYS: FormJourney[] = ["delay", "not_started", "aborted_return", "continued_extra"];

/** Fill DB's official form for this trip, store it with the trip, return it. */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const trip = getTrip((await params).id);
  if (!trip) return NextResponse.json({ error: "Fahrt nicht gefunden" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const p = getProfile();

  const missing: string[] = [];
  if (!p.firstName || !p.lastName) missing.push("Name");
  if (!p.street || !p.postcode || !p.city) missing.push("Adresse");
  if (p.payout === "transfer" && !ibanValid(p.iban)) missing.push("gültige IBAN");
  if (missing.length)
    return NextResponse.json({ error: `In den Einstellungen fehlt: ${missing.join(", ")}`, missing }, { status: 400 });

  const expectedDelayMin = trip.expectedDelayMin;
  const span = ticketSpan(trip);
  const ent = assess({
    status: trip.status,
    price: trip.price,
    plannedArrival: span.arrival,
    actualArrival: trip.actualArrival,
    expectedDelayMin,
    returnedToStart: trip.returnedToStart,
    roundTrip: trip.roundTrip,
    directionPrice: trip.ticket?.directionPrice ?? null,
  });
  if (!ent) return NextResponse.json({ error: "Für diese Fahrt besteht laut den DB-Regeln kein Anspruch." }, { status: 400 });
  if (!ent.payable) return NextResponse.json({ error: ent.caveats[0] ?? "Laut den DB-Regeln wird hier nichts ausgezahlt." }, { status: 400 });
  const journey = JOURNEYS.includes(b.journey as FormJourney) ? (b.journey as FormJourney) : ent.journey;
  if (!journey)
    return NextResponse.json(
      { error: "Für diesen Fall hat das Papierformular kein passendes Feld – bitte online (bahn.de / DB Navigator) oder im Reisezentrum beantragen." },
      { status: 400 },
    );

  const extra = (b.extra ?? {}) as Record<string, unknown>;
  const pdf = await fillClaimForm({
    trip,
    profile: p,
    journey,
    station: typeof b.station === "string" ? b.station : null,
    extra: { ticket: extra.ticket === true, transport: extra.transport === true, overnight: extra.overnight === true, other: extra.other === true },
    reservationUnused: b.reservationUnused === true,
    signature: getSignature(),
  });
  const name = `Fahrgastrechte ${trip.date} ${span.from}-${span.to}.pdf`;
  // Generated again (e.g. after adding the signature) → replace the unsent draft instead of adding a second claim.
  const draft = trip.claims.find((c) => c.status === "draft" && !c.caseId);
  const oldForm = draft?.notes ? /Formular erzeugt \((att_[^)]+)\)/.exec(draft.notes)?.[1] : undefined;
  const attachment = saveAttachment(trip.id, { name, type: "application/pdf", bytes: Buffer.from(pdf) }, "claim", "Fahrgastrechte-Formular");
  if (oldForm && trip.attachments.some((a) => a.id === oldForm)) deleteAttachment(oldForm);
  const claim = saveClaim(trip.id, {
    id: draft?.id,
    type: journey,
    delayMin: journey === "delay" ? arrivalDelayMin(span.arrival, trip.actualArrival) : expectedDelayMin,
    amount: ent.amount ?? null,
    payout: p.payout,
    notes: `Formular erzeugt (${attachment.id}). Einsenden an: ${FORM_ADDRESS}`,
  });
  return NextResponse.json({ attachment, claim, entitlement: ent, address: FORM_ADDRESS });
}

const CLAIM_STATUSES = new Set(["draft", "submitted", "paid", "rejected"]);

/** Track a claim: submitted / paid (amount) / rejected. */
export async function PATCH(req: Request, { params }: Ctx) {
  ensureReady();
  const tripId = (await params).id;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.id !== "string") return NextResponse.json({ error: "id fehlt" }, { status: 400 });
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : v === null ? null : undefined);
  const claim = saveClaim(tripId, {
    id: b.id,
    status: typeof b.status === "string" && CLAIM_STATUSES.has(b.status) ? b.status : undefined,
    submittedAt: num(b.submittedAt),
    paidAt: num(b.paidAt),
    paidAmount: num(b.paidAmount),
    decidedAt: num(b.decidedAt),
    notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : undefined,
  });
  return NextResponse.json({ claim });
}
