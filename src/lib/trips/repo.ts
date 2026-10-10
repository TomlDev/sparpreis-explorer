import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { carryRealtime } from "./realtime";
import {
  attachments,
  claims,
  tripEvents,
  trips,
  type AttachmentRow,
  type ClaimRow,
  type TripEventRow,
  type TicketInfo,
  type TripLeg,
  type TripRow,
} from "@/db/schema";
import { newId, now } from "@/db/util";
import { formatInTimeZone } from "date-fns-tz";
import { berlinToIso } from "@/lib/time";

const TZ = "Europe/Berlin";

/** moved = not taken; the ticket was used for another journey (see movedFrom). */
export const TRIP_STATUSES = ["planned", "done", "delayed", "aborted", "not_started", "cancelled", "moved"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export interface TripInput {
  date?: string;
  legs: TripLeg[];
  source?: string;
  fingerprint?: string | null;
  refreshToken?: string | null;
  orderNumber?: string | null;
  price?: number | null;
  klasse?: number | null;
  ticketType?: string | null;
  direction?: string | null;
  ticket?: TicketInfo | null;
  roundTrip?: boolean;
  notes?: string | null;
  movedFrom?: string | null;
}

export interface TripDetail extends TripRow {
  events: TripEventRow[];
  attachments: AttachmentRow[];
  claims: ClaimRow[];
  /** status "moved": the journey actually made on this ticket */
  movedTo: Pick<TripRow, "id" | "date" | "plannedDeparture" | "originName" | "destName" | "status"> | null;
  /** replacement journey: the booked trip whose ticket it uses */
  movedFromTrip: Pick<TripRow, "id" | "date" | "plannedDeparture" | "originName" | "destName" | "expectedDelayMin"> | null;
}

const rideLegs = (legs: TripLeg[]) => legs.filter((l) => !l.isWalking);

function summary(legs: TripLeg[]) {
  const rides = rideLegs(legs);
  const first = rides[0] ?? legs[0];
  const last = rides[rides.length - 1] ?? legs[legs.length - 1];
  return {
    originName: first?.fromName ?? "?",
    destName: last?.toName ?? "?",
    plannedDeparture: first?.plannedDeparture ?? null,
    plannedArrival: last?.plannedArrival ?? null,
  };
}

export function dayOf(iso: string | null | undefined): string | null {
  return iso ? formatInTimeZone(new Date(iso), TZ, "yyyy-MM-dd") : null;
}

export function createTrip(input: TripInput): TripRow {
  if (!input.legs?.length) throw new Error("Fahrt ohne Abschnitte");
  const s = summary(input.legs);
  const date = input.date ?? dayOf(s.plannedDeparture);
  if (!date) throw new Error("Datum fehlt");
  // Same connection twice (e.g. "Gebucht" tapped again) → keep the existing one.
  if (input.fingerprint) {
    const dup = db
      .select()
      .from(trips)
      .where(and(eq(trips.fingerprint, input.fingerprint), eq(trips.date, date)))
      .get();
    if (dup) return dup;
  }
  const row: TripRow = {
    id: newId("trip"),
    date,
    ...s,
    legs: input.legs,
    status: "planned",
    source: input.source ?? "manual",
    fingerprint: input.fingerprint ?? null,
    refreshToken: input.refreshToken ?? null,
    orderNumber: input.orderNumber ?? null,
    price: input.price ?? null,
    klasse: input.klasse ?? null,
    ticketType: input.ticketType ?? null,
    direction: input.direction ?? null,
    ticket: input.ticket ?? null,
    actualArrival: null,
    actualLegs: null,
    abortedAt: null,
    expectedDelayMin: null,
    returnedToStart: false,
    roundTrip: input.roundTrip ?? false,
    notes: input.notes ?? null,
    plan: null,
    movedFrom: input.movedFrom ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.insert(trips).values(row).run();
  return row;
}

export function listTrips(from: string, to: string): TripRow[] {
  return db
    .select()
    .from(trips)
    .where(and(gte(trips.date, from), lte(trips.date, to)))
    .orderBy(asc(trips.date), asc(trips.plannedDeparture))
    .all();
}

export function getTrip(id: string): TripDetail | null {
  const t = db.select().from(trips).where(eq(trips.id, id)).get();
  if (!t) return null;
  return {
    ...t,
    events: db.select().from(tripEvents).where(eq(tripEvents.tripId, id)).orderBy(asc(tripEvents.at)).all(),
    attachments: db.select().from(attachments).where(eq(attachments.tripId, id)).orderBy(asc(attachments.createdAt)).all(),
    claims: db.select().from(claims).where(eq(claims.tripId, id)).orderBy(desc(claims.createdAt)).all(),
    movedTo: db
      .select({ id: trips.id, date: trips.date, plannedDeparture: trips.plannedDeparture, originName: trips.originName, destName: trips.destName, status: trips.status })
      .from(trips)
      .where(eq(trips.movedFrom, id))
      .get() ?? null,
    movedFromTrip: t.movedFrom
      ? (db
          .select({ id: trips.id, date: trips.date, plannedDeparture: trips.plannedDeparture, originName: trips.originName, destName: trips.destName, expectedDelayMin: trips.expectedDelayMin })
          .from(trips)
          .where(eq(trips.id, t.movedFrom))
          .get() ?? null)
      : null,
  };
}

const EDITABLE = [
  "status",
  "orderNumber",
  "price",
  "klasse",
  "ticketType",
  "direction",
  "actualArrival",
  "actualLegs",
  "abortedAt",
  "expectedDelayMin",
  "returnedToStart",
  "roundTrip",
  "ticket",
  "notes",
  "legs",
  "plan",
] as const;
type Editable = (typeof EDITABLE)[number];

export function updateTrip(id: string, patch: Partial<Pick<TripRow, Editable>>): TripRow | null {
  const set: Partial<TripRow> = { updatedAt: now() };
  for (const k of EDITABLE) if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  if (set.status && !(TRIP_STATUSES as readonly string[]).includes(set.status)) throw new Error("ungültiger Status");
  if (set.plan !== undefined && set.plan !== null && set.plan !== "take" && set.plan !== "skip") throw new Error("ungültige Planung");
  if (set.legs) {
    // Re-import / edit: what we tracked on the same trains stays (live observations are evidence).
    const before = db.select({ legs: trips.legs }).from(trips).where(eq(trips.id, id)).get();
    if (before) set.legs = carryRealtime(before.legs, set.legs);
    Object.assign(set, summary(set.legs), { date: dayOf(summary(set.legs).plannedDeparture) ?? undefined });
  }
  db.update(trips).set(set).where(eq(trips.id, id)).run();
  return db.select().from(trips).where(eq(trips.id, id)).get() ?? null;
}

/** Same wall-clock times n days later (Berlin time, so a DST change keeps 08:12 at 08:12). */
function shiftIso(iso: string | null, days: number): string | null {
  if (!iso) return iso;
  const day = formatInTimeZone(new Date(iso), TZ, "yyyy-MM-dd");
  const [y, m, d] = day.split("-").map(Number);
  const to = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return berlinToIso(to, formatInTimeZone(new Date(iso), TZ, "HH:mm")) ?? iso;
}

/**
 * "Mit dem Ticket an einem anderen Tag / mit einer anderen Verbindung gefahren":
 * the booked trip becomes "moved" and points to the journey actually made —
 * an existing trip of that day (e.g. booked via the search) or a copy of the
 * same trains on the new date. The replacement carries the ticket data (claims
 * on it need order number and price) but never real-time data of the original.
 */
export function moveTrip(id: string, opts: { date: string; targetId?: string | null }): TripRow {
  const from = db.select().from(trips).where(eq(trips.id, id)).get();
  if (!from) throw new Error("Fahrt nicht gefunden");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("Datum fehlt");
  if (from.movedFrom) throw new Error("Das ist schon eine Ersatzfahrt");
  const existing = db.select().from(trips).where(eq(trips.movedFrom, id)).get();
  if (existing) throw new Error("Für diese Fahrt ist schon eine Ersatzfahrt eingetragen");
  const ticketData = {
    orderNumber: from.orderNumber,
    price: from.price,
    klasse: from.klasse,
    ticketType: from.ticketType,
    direction: from.direction,
    roundTrip: from.roundTrip,
    ticket: from.ticket,
  };
  let target: TripRow;
  if (opts.targetId) {
    const t = db.select().from(trips).where(eq(trips.id, opts.targetId)).get();
    if (!t || t.id === id) throw new Error("Ersatzfahrt nicht gefunden");
    if (t.movedFrom) throw new Error("Diese Fahrt ist schon Ersatz für eine andere");
    // Ticket fields the replacement doesn't have yet come from the booked trip.
    const fill = Object.fromEntries(
      Object.entries(ticketData).filter(([k]) => t[k as keyof TripRow] == null || (k === "roundTrip" && !t.roundTrip)),
    );
    db.update(trips).set({ ...fill, movedFrom: id, plan: "take", updatedAt: now() }).where(eq(trips.id, t.id)).run();
    target = db.select().from(trips).where(eq(trips.id, t.id)).get()!;
  } else {
    const days = Math.round((Date.parse(`${opts.date}T12:00:00Z`) - Date.parse(`${from.date}T12:00:00Z`)) / 86_400_000);
    const legs: TripLeg[] = from.legs.map((l) => ({
      product: l.product,
      lineName: l.lineName,
      trainNumber: l.trainNumber,
      fromId: l.fromId,
      fromName: l.fromName,
      toId: l.toId,
      toName: l.toName,
      plannedDeparture: shiftIso(l.plannedDeparture, days),
      plannedArrival: shiftIso(l.plannedArrival, days),
      isWalking: l.isWalking,
      depPlatform: l.depPlatform,
      arrPlatform: l.arrPlatform,
    }));
    target = createTrip({ date: opts.date, legs, source: "copy", ...ticketData, movedFrom: id });
    db.update(trips).set({ plan: "take" }).where(eq(trips.id, target.id)).run();
  }
  db.update(trips).set({ status: "moved", plan: "skip", updatedAt: now() }).where(eq(trips.id, id)).run();
  return target;
}

/** Undo moveTrip: the booked trip is "planned" again; a copied replacement is deleted, a linked one only unlinked. */
export function unmoveTrip(id: string): void {
  const repl = db.select().from(trips).where(eq(trips.movedFrom, id)).get();
  if (repl) {
    const untouched =
      !db.select().from(tripEvents).where(eq(tripEvents.tripId, repl.id)).get() &&
      !db.select().from(attachments).where(eq(attachments.tripId, repl.id)).get() &&
      !db.select().from(claims).where(eq(claims.tripId, repl.id)).get();
    if (repl.source === "copy" && untouched) deleteTrip(repl.id);
    else db.update(trips).set({ movedFrom: null, updatedAt: now() }).where(eq(trips.id, repl.id)).run();
  }
  db.update(trips).set({ status: "planned", plan: null, updatedAt: now() }).where(eq(trips.id, id)).run();
}

export function deleteTrip(id: string): void {
  if (!db.select().from(trips).where(eq(trips.id, id)).get()) return;
  for (const a of db.select().from(attachments).where(eq(attachments.tripId, id)).all()) removeFile(a.path);
  db.delete(trips).where(eq(trips.id, id)).run();
  db.update(trips).set({ movedFrom: null }).where(eq(trips.movedFrom, id)).run();
  // Our own id format only (never a path from outside).
  if (/^trip_[0-9a-f-]{36}$/.test(id)) fs.rmSync(path.join(/*turbopackIgnore: true*/ uploadsDir(), id), { recursive: true, force: true });
}

// ---- events (Kontrolle, Notiz, …) ----

/** Ride (non-walking leg) the passenger was on at time `at` (planned times;
 *  after a leg's arrival we still attribute to it until the next departs). */
export function legAt(legs: TripLeg[], at: number): number | null {
  let idx: number | null = null;
  let prevArrival = -Infinity;
  for (const [i, l] of legs.entries()) {
    if (l.isWalking || !l.plannedDeparture) continue;
    // Actual times where known: a late train is still "the" train after its planned arrival.
    const dep = new Date(l.rt?.dep ?? l.plannedDeparture).getTime();
    // Boarding window of 5 min — but not while the previous train is still running.
    const from = Math.max(dep - 5 * 60_000, prevArrival);
    if (at >= from) idx = i;
    const arr = l.rt?.arr ?? l.plannedArrival;
    if (arr) prevArrival = new Date(arr).getTime();
  }
  return idx;
}

export function addEvent(
  tripId: string,
  e: { type: string; at?: number; lat?: number | null; lng?: number | null; accuracy?: number | null; text?: string | null; legIndex?: number | null },
): TripEventRow {
  const t = db.select().from(trips).where(eq(trips.id, tripId)).get();
  if (!t) throw new Error("Fahrt nicht gefunden");
  const at = e.at ?? now();
  const row: TripEventRow = {
    id: newId("ev"),
    tripId,
    type: e.type,
    at,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    accuracy: e.accuracy ?? null,
    legIndex: e.legIndex ?? legAt(t.legs, at),
    text: e.text ?? null,
    context: null,
    createdAt: now(),
  };
  db.insert(tripEvents).values(row).run();
  return row;
}

export function updateEvent(
  id: string,
  patch: { at?: number; lat?: number | null; lng?: number | null; accuracy?: number | null; text?: string | null },
): TripEventRow | null {
  const e = db.select().from(tripEvents).where(eq(tripEvents.id, id)).get();
  if (!e) return null;
  const set: Partial<TripEventRow> = {};
  for (const k of ["at", "lat", "lng", "accuracy", "text"] as const) if (patch[k] !== undefined) (set as Record<string, unknown>)[k] = patch[k];
  if (set.at !== undefined) {
    const t = db.select().from(trips).where(eq(trips.id, e.tripId)).get();
    if (t) set.legIndex = legAt(t.legs, set.at);
  }
  // Time or place changed → the train position found for the old values no longer applies.
  if (set.at !== undefined || set.lat !== undefined || set.lng !== undefined) set.context = null;
  db.update(tripEvents).set(set).where(eq(tripEvents.id, id)).run();
  return db.select().from(tripEvents).where(eq(tripEvents.id, id)).get() ?? null;
}

export function setEventContext(id: string, context: TripEventRow["context"]): void {
  db.update(tripEvents).set({ context }).where(eq(tripEvents.id, id)).run();
}

export function deleteEvent(id: string): void {
  db.delete(tripEvents).where(eq(tripEvents.id, id)).run();
}

// ---- attachments ----

export function uploadsDir(): string {
  const p = process.env.DATABASE_PATH || "./data/bahn-finder.db";
  const abs = path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ process.cwd(), p);
  return path.join(/*turbopackIgnore: true*/ path.dirname(abs), "uploads");
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
  "application/pdf": "pdf",
};
export const MAX_UPLOAD = 20 * 1024 * 1024;

export function saveAttachment(
  tripId: string | null,
  file: { name: string; type: string; bytes: Buffer },
  kind: string,
  caption?: string | null,
): AttachmentRow {
  const ext = MIME_EXT[file.type];
  if (!ext) throw new Error(`Dateityp nicht erlaubt: ${file.type || "unbekannt"}`);
  if (file.bytes.length > MAX_UPLOAD) throw new Error("Datei zu groß (max. 20 MB)");
  const id = newId("att");
  const rel = `${tripId ?? "_inbox"}/${id}.${ext}`; // relative to uploadsDir()
  const abs = path.join(/*turbopackIgnore: true*/ uploadsDir(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  fs.writeFileSync(abs, file.bytes, { mode: 0o600 });
  const row: AttachmentRow = {
    id,
    tripId,
    kind,
    filename: file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120) || `${id}.${ext}`,
    mime: file.type,
    size: file.bytes.length,
    path: rel,
    caption: caption ?? null,
    takenAt: null,
    createdAt: now(),
  };
  db.insert(attachments).values(row).run();
  return row;
}

export function getAttachment(id: string): (AttachmentRow & { abs: string }) | null {
  const a = db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!a) return null;
  const abs = path.join(/*turbopackIgnore: true*/ uploadsDir(), a.path);
  // Paths are generated by us, but never serve anything outside the uploads dir.
  if (!abs.startsWith(uploadsDir() + path.sep)) return null;
  return { ...a, abs };
}

function removeFile(rel: string) {
  const abs = path.join(/*turbopackIgnore: true*/ uploadsDir(), rel);
  if (abs.startsWith(uploadsDir() + path.sep)) fs.rmSync(abs, { force: true });
}

export function deleteAttachment(id: string): void {
  const a = db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!a) return;
  removeFile(a.path);
  db.delete(attachments).where(eq(attachments.id, id)).run();
}

// ---- today ----

/** Trips relevant right now: today's trips plus any still running (overnight). */
export function currentTrips(at = now()): TripRow[] {
  const today = formatInTimeZone(new Date(at), TZ, "yyyy-MM-dd");
  const yesterday = formatInTimeZone(new Date(at - 86_400_000), TZ, "yyyy-MM-dd");
  return listTrips(yesterday, today).filter((t) => {
    if (t.date === today) return true;
    const arr = t.plannedArrival ? new Date(t.plannedArrival).getTime() : 0;
    return arr + 3 * 3600_000 > at; // yesterday's trip still under way
  });
}

// ---- claims ----

export function saveClaim(
  tripId: string,
  c: Partial<Omit<ClaimRow, "id" | "tripId" | "createdAt" | "updatedAt">> & { id?: string },
): ClaimRow {
  if (c.id) {
    const { id, ...rest } = c;
    db.update(claims)
      .set({ ...rest, updatedAt: now() })
      .where(and(eq(claims.id, id), eq(claims.tripId, tripId)))
      .run();
    return db.select().from(claims).where(eq(claims.id, id)).get()!;
  }
  const row: ClaimRow = {
    id: newId("claim"),
    tripId,
    type: c.type ?? "delay",
    status: c.status ?? "draft",
    delayMin: c.delayMin ?? null,
    amount: c.amount ?? null,
    payout: c.payout ?? "transfer",
    submittedAt: c.submittedAt ?? null,
    paidAt: c.paidAt ?? null,
    paidAmount: c.paidAmount ?? null,
    caseId: c.caseId ?? null,
    decidedAt: c.decidedAt ?? null,
    reason: c.reason ?? null,
    notes: c.notes ?? null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.insert(claims).values(row).run();
  return row;
}

/**
 * Fold a duplicate into `keepId`: claims, events and attachments move over
 * (files included); what happened (status, abort, notes) is kept when the
 * target doesn't know it yet. Used for trips first created from a
 * passenger-rights mail and later imported from the booking.
 */
export function mergeTrips(keepId: string, dropId: string): TripRow | null {
  const keep = db.select().from(trips).where(eq(trips.id, keepId)).get();
  const drop = db.select().from(trips).where(eq(trips.id, dropId)).get();
  if (!keep || !drop || keep.id === drop.id) return keep ?? null;
  db.update(claims).set({ tripId: keepId }).where(eq(claims.tripId, dropId)).run();
  db.update(tripEvents).set({ tripId: keepId }).where(eq(tripEvents.tripId, dropId)).run();
  for (const a of db.select().from(attachments).where(eq(attachments.tripId, dropId)).all()) {
    const rel = `${keepId}/${path.basename(a.path)}`;
    const from = path.join(/*turbopackIgnore: true*/ uploadsDir(), a.path);
    const to = path.join(/*turbopackIgnore: true*/ uploadsDir(), rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    if (fs.existsSync(from)) fs.renameSync(from, to);
    db.update(attachments).set({ tripId: keepId, path: rel }).where(eq(attachments.id, a.id)).run();
  }
  const patch: Partial<TripRow> = {};
  if (keep.status === "planned" && drop.status !== "planned") patch.status = drop.status;
  if (!keep.abortedAt && drop.abortedAt) patch.abortedAt = drop.abortedAt;
  if (keep.expectedDelayMin == null && drop.expectedDelayMin != null) patch.expectedDelayMin = drop.expectedDelayMin;
  if (keep.price == null && drop.price != null) patch.price = drop.price;
  if (!keep.actualArrival && drop.actualArrival) patch.actualArrival = drop.actualArrival;
  if (!keep.actualLegs && drop.actualLegs) patch.actualLegs = drop.actualLegs;
  if (!keep.returnedToStart && drop.returnedToStart) patch.returnedToStart = true;
  if (!keep.roundTrip && drop.roundTrip) patch.roundTrip = true;
  if (drop.notes) patch.notes = keep.notes ? `${keep.notes}\n${drop.notes}` : drop.notes;
  const legs = carryRealtime(drop.legs, keep.legs);
  if (JSON.stringify(legs) !== JSON.stringify(keep.legs)) patch.legs = legs;
  if (Object.keys(patch).length) db.update(trips).set({ ...patch, updatedAt: now() }).where(eq(trips.id, keepId)).run();
  deleteTrip(dropId);
  return db.select().from(trips).where(eq(trips.id, keepId)).get() ?? null;
}

/** Merge claim-created trips into the booking imported for the same order + day. */
export function mergeClaimDuplicates(): number {
  let merged = 0;
  for (const c of db.select().from(trips).where(eq(trips.source, "claim")).all()) {
    if (!c.orderNumber) continue;
    const twin = db
      .select()
      .from(trips)
      .where(and(eq(trips.orderNumber, c.orderNumber), eq(trips.date, c.date)))
      .all()
      .find((t) => t.id !== c.id && t.source !== "claim");
    if (twin && mergeTrips(twin.id, c.id)) merged++;
  }
  return merged;
}
