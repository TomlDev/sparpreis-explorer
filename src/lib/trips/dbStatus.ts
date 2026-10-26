import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, type DbTripStatus, type TripRow } from "@/db/schema";
import { closeDbWatch, fetchReiseketten, type DbReisekette } from "./dbBrowser";
import { dbPassword, getDbUser } from "./dbAccount";
import { addEvent, updateTrip } from "./repo";
import { dbStatusText } from "./dbStatusText";

/**
 * DB's own verdict on a booked journey — the "Reisebegleitung" behind the DB
 * Navigator: is it still makeable as booked (status), is the Zugbindung lifted,
 * should / may you look for alternatives. Read from the DB account every 10 min
 * while a booked trip is under way (one bahn.de tab kept open meanwhile) and
 * kept on the trip; changes are logged on the trip as evidence.
 */

const EVERY_MS = 10 * 60_000;
const BEFORE_MS = 30 * 60_000; // from 30 min before the trip …
const AFTER_MS = 30 * 60_000; // … until 30 min after its arrival
const IDLE_CLOSE_MS = 15 * 60_000;

const g = globalThis as { __dbStatusLast?: number; __dbStatusIdle?: number; __dbStatusBusy?: boolean };
const HARD_LIMIT_MS = 2 * 60_000; // a run never takes longer (login + page load)
const MIN_GAP_MS = 2 * 60_000;

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
/** "2026-10-15T08:27:00" (Berlin local, from DB) → epoch ms */
const localMs = (local: string | null | undefined, offsetMin = 120) =>
  local ? new Date(`${local}${offsetMin >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMin) % 60).padStart(2, "0")}`).getTime() : NaN;

/** The DB entry of a trip: same order, leaving at the same time (a round trip has two). */
export function matchKette(t: Pick<TripRow, "orderNumber" | "plannedDeparture" | "date">, ketten: DbReisekette[]): DbReisekette | null {
  if (!t.orderNumber) return null;
  const mine = ketten.filter((k) => k.auftrag?.auftragsnummer === t.orderNumber);
  const dep = ms(t.plannedDeparture);
  const at = (k: DbReisekette) => localMs(k.origin?.dateTime?.local, (k.origin?.dateTime as { offset?: number } | undefined)?.offset ?? 120);
  return (
    mine.find((k) => Number.isFinite(dep) && Math.abs(at(k) - dep) <= 10 * 60_000) ??
    mine.find((k) => k.origin?.dateTime?.local?.startsWith(t.date)) ??
    null
  );
}

export function toStatus(k: DbReisekette, now: number): DbTripStatus {
  return {
    status: k.status ?? null,
    zugbindung: k.auftrag?.zugbindung ?? null,
    alternativen: k.alternativensuche ?? null,
    relevanteAbweichung: !!k.relevanteAbweichung,
    rtArrival: k.destination?.rtDateTime?.local ?? null,
    checkedAt: now,
  };
}

/** Trips the DB watch is for right now: booked (order number), not over, from 30 min before. */
function activeTrips(now: number): TripRow[] {
  return db
    .select()
    .from(trips)
    .all()
    .filter((t) => {
      if (!t.orderNumber || !["planned", "delayed", "lifted"].includes(t.status)) return false;
      const dep = ms(t.plannedDeparture);
      const arr = ms(t.plannedArrival) + Math.max(0, (t.expectedDelayMin ?? 0) * 60_000);
      return Number.isFinite(dep) && now >= dep - BEFORE_MS && now <= (Number.isFinite(arr) ? arr : dep + 12 * 3600_000) + AFTER_MS;
    });
}

/** Store DB's state on the trips; a change of the verdict is logged as evidence. */
export function applyReiseketten(list: TripRow[], ketten: DbReisekette[], now: number): number {
  let n = 0;
  for (const t of list) {
    const k = matchKette(t, ketten);
    if (!k) continue;
    const next = toStatus(k, now);
    const prev = t.dbStatus;
    updateTrip(t.id, { dbStatus: next });
    n++;
    if (!prev || prev.zugbindung !== next.zugbindung || prev.status !== next.status || prev.alternativen !== next.alternativen) {
      const time = new Date(now).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
      addEvent(t.id, { type: "delay", at: now, text: `DB-Reisebegleitung (${time}): ${dbStatusText(next)}` });
    }
  }
  return n;
}

/** Called by the live scheduler every minute: every 10 min while a booked trip is under way. */
export async function dbStatusTick(now = Date.now()): Promise<void> {
  if (!getDbUser() || !dbPassword()) return;
  const list = activeTrips(now);
  if (!list.length) {
    // nothing under way: close the kept-open tab after a while
    if (globalThis.__dbWatch && now - (g.__dbStatusIdle ??= now) > IDLE_CLOSE_MS) await closeDbWatch();
    return;
  }
  g.__dbStatusIdle = undefined;
  // per trip: one just entering the window (or whose state is 10 min old) is asked for right away;
  // at most one run every 2 min (a failing run doesn't hammer bahn.de)
  const due = list.some((t) => !t.dbStatus || now - t.dbStatus.checkedAt >= EVERY_MS);
  if (g.__dbStatusBusy || !due || now - (g.__dbStatusLast ?? 0) < MIN_GAP_MS) return;
  g.__dbStatusLast = now;
  g.__dbStatusBusy = true;
  try {
    const ketten = await Promise.race([
      fetchReiseketten(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Zeitlimit")), HARD_LIMIT_MS)),
    ]);
    const n = applyReiseketten(list, ketten, now);
    console.log(`[dbstatus] ${ketten.length} Reiseketten, ${n}/${list.length} Fahrt(en) zugeordnet`);
  } catch (e) {
    console.error("[dbstatus]", (e as Error).message.slice(0, 160));
    if (/Zeitlimit/.test((e as Error).message)) await closeDbWatch();
  } finally {
    g.__dbStatusBusy = false;
  }
}

/** For a page view: read once now (e.g. "aktualisieren"). */
export async function refreshDbStatus(tripId: string, now = Date.now()): Promise<DbTripStatus | null> {
  const t = db.select().from(trips).where(eq(trips.id, tripId)).get();
  if (!t?.orderNumber) return null;
  applyReiseketten([t], await fetchReiseketten(), now);
  g.__dbStatusLast = now;
  return db.select().from(trips).where(eq(trips.id, tripId)).get()?.dbStatus ?? null;
}
