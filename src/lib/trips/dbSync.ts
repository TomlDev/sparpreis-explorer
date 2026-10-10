import { isNotNull } from "drizzle-orm";
import { db } from "@/db/client";
import { trips } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { todayLocal } from "@/lib/time";
import { getDbUser, hasDbPassword, setDbAccountStatus, type DbAccountStatus } from "./dbAccount";
import { DbLoginError, withDbSession, type DbDirection, type DbOffer, type DbOrder, type DbOrderDetail } from "./dbBrowser";
import { updateTrip } from "./repo";

/** What one direction of a booking cost (cancelled offers don't count). */
export function directionPrice(offers: DbOffer[] | undefined): number | null {
  const live = (offers ?? []).filter((o) => !o.isStorniert && typeof o.preis?.betrag === "number");
  if (!live.length) return null;
  return Math.round(live.reduce((s, o) => s + o.preis!.betrag! * 100, 0)) / 100;
}

const day = (dt: string | undefined) => (dt && /^\d{4}-\d{2}-\d{2}/.test(dt) ? dt.slice(0, 10) : null);

/**
 * Account bookings → app trips: per order number and direction (or travel day)
 * the price of that direction goes into the trip. Returns trips updated and the
 * bookings the app doesn't know.
 */
export function applyOrders(
  orders: DbOrder[],
  details: Map<string, DbOrderDetail>,
  list = db.select().from(trips).where(isNotNull(trips.orderNumber)).all(),
): { updated: number; unknown: DbAccountStatus["unknown"] } {
  let updated = 0;
  const unknown: DbAccountStatus["unknown"] = [];
  for (const o of orders) {
    const nr = o.auftragsnummer;
    if (!nr) continue;
    const mine = list.filter((t) => t.orderNumber === nr);
    const detail = details.get(nr);
    for (const g of o.gesamtreisen ?? []) {
      for (const [dirKey, dir] of [
        ["hinfahrt", g.hinfahrt],
        ["rueckfahrt", g.rueckfahrt],
      ] as [("hinfahrt" | "rueckfahrt"), DbDirection | undefined][]) {
        if (!dir) continue;
        const d = day(dir.abfahrt);
        const trip =
          mine.find((t) => t.direction === (dirKey === "hinfahrt" ? "outbound" : "return") && (!d || t.date === d)) ??
          mine.find((t) => d && t.date === d);
        if (!trip) {
          unknown.push({ orderNumber: nr, date: d, from: dir.startort ?? null, to: dir.zielort ?? null, tariff: dir.name ?? null });
          continue;
        }
        if (!trip.roundTrip || !detail) continue;
        const price = directionPrice(detail.gesamtangebot?.[dirKey]?.angebote);
        if (price == null || trip.ticket?.directionPrice === price) continue;
        updateTrip(trip.id, { ticket: { ...(trip.ticket ?? {}), directionPrice: price } });
        updated++;
      }
    }
  }
  return { updated, unknown };
}

/** Log in (if needed), read "Meine Reisen" and the details of round trips the app knows. */
export async function syncDbAccount(): Promise<DbAccountStatus> {
  try {
    const result = await withDbSession(async ({ orders, getJson }) => {
      const list = orders.auftraege ?? [];
      const known = new Map(
        db.select().from(trips).where(isNotNull(trips.orderNumber)).all().map((t) => [t.orderNumber!, t]),
      );
      const details = new Map<string, DbOrderDetail>();
      for (const o of list) {
        const nr = o.auftragsnummer;
        // Details only where they matter: round trips without the direction price yet.
        if (!nr || !known.get(nr)?.roundTrip) continue;
        const both = db.select().from(trips).all().filter((t) => t.orderNumber === nr);
        if (both.every((t) => t.ticket?.directionPrice != null)) continue;
        details.set(nr, await getJson<DbOrderDetail>(`/web/api/buchung/auftrag/${encodeURIComponent(nr)}`));
      }
      return { ...applyOrders(list, details), count: list.length, more: !!orders.hasMoreAuftraege };
    });
    return setDbAccountStatus({
      lastRunAt: Date.now(),
      lastOk: true,
      lastMessage: `${result.count} Buchung(en) im DB-Konto${result.more ? " (nur die neuesten)" : ""}, ${result.updated} Fahrt(en) aktualisiert`,
      unknown: result.unknown,
      updated: result.updated,
    });
  } catch (e) {
    const msg = e instanceof DbLoginError ? e.message : `Abgleich fehlgeschlagen: ${(e as Error).message.slice(0, 200)}`;
    return setDbAccountStatus({ lastRunAt: Date.now(), lastOk: false, lastMessage: msg });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __dbSyncTimer: ReturnType<typeof setInterval> | undefined;
}

/** Once a day (from 07:00): sync the account if one is set up. */
export function startDbSyncPolling(): void {
  if (globalThis.__dbSyncTimer || process.env.NODE_ENV === "test") return;
  const tick = () => {
    if (!getDbUser() || !hasDbPassword()) return;
    const today = todayLocal();
    const hour = Number(new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin", hour: "numeric", hour12: false }));
    if (hour < 7 || getSetting<string>("dbaccount:lastAuto") === today) return;
    setSetting("dbaccount:lastAuto", today);
    syncDbAccount().catch(() => {});
  };
  globalThis.__dbSyncTimer = setInterval(tick, 30 * 60_000);
  globalThis.__dbSyncTimer.unref();
}
