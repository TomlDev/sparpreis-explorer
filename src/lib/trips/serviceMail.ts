import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tripEvents, trips, type TripRow } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { addEvent, updateTrip } from "./repo";
import { inferVoucherUse, type VoucherBooking, type VoucherQuestion } from "./voucherUse";

/**
 * Other DB service mails:
 *  - "Fahrplanänderung für Ihre Reise nach … am 09. Okt. 2026": attached to
 *    the trip (order number + day) incl. whether DB lifted the Zugbindung.
 *  - "Ihr Gutschein der Deutschen Bahn": (remaining-value) vouchers, kept in
 *    a small wallet.
 */

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mär: "03", mrz: "03", apr: "04", mai: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", okt: "10", nov: "11", dez: "12",
};

/** "09. Okt. 2026" / "9. Oktober 2026" / "09.10.2026" → "2026-10-09". */
export function germanDate(s: string): string | null {
  const valid = (y: string, m: string, d: string) => {
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    const t = new Date(`${iso}T12:00:00Z`);
    // Reject 99.99.2026, 31.02.2026, …
    return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
  };
  const num = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s);
  if (num) return valid(num[3], num[2], num[1]);
  const m = /(\d{1,2})\.\s*([A-Za-zäÄ]{3})[a-zä]*\.?\s+(\d{4})/.exec(s);
  const mm = m ? MONTHS[m[2].toLowerCase()] : undefined;
  return m && mm ? valid(m[3], mm, m[1]) : null;
}

export interface ScheduleChange {
  orderNumber: string | null;
  date: string | null;
  from: string | null;
  to: string | null;
  zugbindungLifted: boolean;
  /** What changed ("Ihre neue Abfahrtszeit … ist 11:35 Uhr statt 11:34 Uhr."). */
  details?: string[];
}

export function parseScheduleChange(subject: string, text: string): ScheduleChange | null {
  if (!/Fahrplan(ä|ae)nderung|Ge(ä|ae)nderte Fahrtzeiten/i.test(subject)) return null;
  const t = text.replace(/\s+/g, " ").slice(0, 50_000);
  const orderNumber = /Auftragsnummer:?\s*(\d{6,})/.exec(t)?.[1] ?? null;
  if (!orderNumber) return null; // can't be matched to a trip ever
  const route = /Reise von (.{1,150}?) nach (.{1,150}?)\s*am (\d{1,2}\.\s*\S{3,10}\s+\d{4})/.exec(t);
  const details = [...t.matchAll(/Ihre neue (?:Abfahrts|Ankunfts)zeit[^.]{1,200}?statt \d{1,2}:\d{2} Uhr\./g)].map((m) => m[0]).slice(0, 6);
  return {
    orderNumber,
    date: germanDate(route?.[3] ?? subject),
    from: route?.[1]?.trim() ?? null,
    to: route?.[2]?.trim() ?? null,
    zugbindungLifted: /Zugbindung ist für Ihre Fahrt aufgehoben/i.test(t),
    details,
  };
}

export function applyScheduleChange(c: ScheduleChange, notifiedAt: Date): TripRow | null {
  if (!c.orderNumber || !c.date) return null;
  const trip = db
    .select()
    .from(trips)
    .where(and(eq(trips.orderNumber, c.orderNumber), eq(trips.date, c.date)))
    .get();
  if (!trip) return null;
  const iso = notifiedAt.toISOString();
  const text = c.zugbindungLifted
    ? "Fahrplanänderung – laut DB ist die Zugbindung aufgehoben (jeder Zug zum Ziel erlaubt)."
    : c.details?.length
      ? `Geänderte Fahrtzeiten: ${c.details.join(" ")}`
      : "Fahrplanänderung gemeldet – bitte Verbindung prüfen.";
  // Same notice again (re-import, re-sync) → nothing to do.
  const known = db
    .select()
    .from(tripEvents)
    .where(and(eq(tripEvents.tripId, trip.id), eq(tripEvents.type, "note"), eq(tripEvents.at, notifiedAt.getTime())))
    .get();
  if (!known) addEvent(trip.id, { type: "note", at: notifiedAt.getTime(), text, legIndex: null });
  // Keep the latest notice; a lifted Zugbindung is never "un-lifted" by a later minor change.
  const cur = trip.ticket?.scheduleChange;
  if (cur && cur.notifiedAt >= iso) return trip;
  return updateTrip(trip.id, {
    ticket: {
      ...(trip.ticket ?? {}),
      scheduleChange: { notifiedAt: iso, zugbindungLifted: c.zugbindungLifted || !!cur?.zugbindungLifted, text },
    },
  });
}

/** Schedule changes whose trip isn't imported yet. */
type Pending = ScheduleChange & { notifiedAt: string };

export function rememberScheduleChange(c: ScheduleChange, notifiedAt: Date): void {
  const list = getSetting<Pending[]>("pendingScheduleChanges") ?? [];
  if (list.some((p) => p.orderNumber === c.orderNumber && p.date === c.date && p.notifiedAt === notifiedAt.toISOString())) return;
  setSetting("pendingScheduleChanges", [...list, { ...c, notifiedAt: notifiedAt.toISOString() }]);
}

export function applyPendingScheduleChanges(): number {
  const list = getSetting<Pending[]>("pendingScheduleChanges") ?? [];
  if (!list.length) return 0;
  const left = list.filter((p) => !applyScheduleChange(p, new Date(p.notifiedAt)));
  setSetting("pendingScheduleChanges", left);
  return list.length - left.length;
}

export interface Voucher {
  number: string;
  value: number;
  validUntil: string | null; // yyyy-MM-dd
  /** Order it came from (a rest voucher: what was left after paying that order). */
  orderNumber: string | null;
  receivedAt: string;
  redeemed: boolean;
  /** Order it paid for (known or worked out, see voucherUse). */
  usedOrder?: string | null;
  /** The rest voucher DB issued for what was left of it. */
  replacedBy?: string | null;
  /** Marked redeemed by the app (old = price + rest), not by the user. */
  autoRedeemed?: boolean;
  /** Rest voucher: the user said none of the candidates paid (don't ask again). */
  useResolved?: boolean;
  /** Orders this voucher did not pay for (answered "nein"). */
  notUsedIn?: string[];
}

export function parseVoucher(subject: string, text: string): Omit<Voucher, "receivedAt" | "redeemed"> | null {
  if (!/Gutschein/i.test(subject)) return null;
  const t = text.replace(/\s+/g, " ");
  const number = /Gutscheinnummer:?\s*([A-Z0-9]{5,})/.exec(t)?.[1];
  const value = /Gutscheinwert:?\s*([\d.]+,\d{2})\s*EUR/.exec(t)?.[1];
  if (!number || !value) return null;
  const until = /Gültig bis:?\s*(\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1];
  return {
    number,
    value: Number(value.replace(/\./g, "").replace(",", ".")),
    validUntil: until ? germanDate(until) : null,
    orderNumber: /Auftrag:?\s*(\d{6,})/.exec(subject)?.[1] ?? null,
  };
}

export const getVouchers = (): Voucher[] => getSetting<Voucher[]>("vouchers") ?? [];

export function saveVoucher(v: Omit<Voucher, "receivedAt" | "redeemed">, receivedAt: Date): Voucher {
  const list = getVouchers();
  const have = list.find((x) => x.number === v.number);
  if (have) {
    // A re-import with the real (original) date corrects a forwarding date.
    if (receivedAt.toISOString() < have.receivedAt) {
      have.receivedAt = receivedAt.toISOString();
      setSetting("vouchers", list);
    }
    return have;
  }
  const next: Voucher = { ...v, receivedAt: receivedAt.toISOString(), redeemed: false };
  setSetting("vouchers", [...list, next]);
  return next;
}

export function setVoucherRedeemed(number: string, redeemed: boolean): Voucher[] {
  return updateVoucher(number, { redeemed });
}

export function updateVoucher(
  number: string,
  patch: Partial<Pick<Voucher, "value" | "validUntil" | "redeemed" | "usedOrder" | "replacedBy" | "autoRedeemed" | "useResolved" | "notUsedIn">>,
): Voucher[] {
  // Only the fields given — `{ value: undefined }` must not wipe the amount.
  const set = Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined));
  const list = getVouchers().map((v) => (v.number === number ? { ...v, ...set } : v));
  setSetting("vouchers", list);
  return list;
}

/**
 * A voucher entered by hand (e.g. from the DB account). A number the app knew
 * already (ticked off, worked out as used, or deleted) comes back as it was –
 * open again, with its amount and validity – so the number alone is enough.
 */
export function addVoucher(v: { number: string; value?: number | null; validUntil?: string | null }): { vouchers: Voucher[]; restored: Voucher | null } {
  const number = v.number.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{5,20}$/.test(number)) throw new Error("Gutscheinnummer ungültig");
  const list = getVouchers();
  const deleted = getSetting<Voucher[]>("vouchersDeleted") ?? [];
  const known = list.find((x) => x.number === number) ?? deleted.find((x) => x.number === number) ?? null;
  const value = v.value != null && v.value > 0 ? v.value : known?.value;
  if (!(value != null && value > 0)) throw new Error("Gutschein unbekannt – Betrag eintragen");
  if (known) {
    // it didn't pay for that booking after all: forget the link, and don't work it out as used again
    const restored: Voucher = {
      ...known,
      value,
      validUntil: v.validUntil ?? known.validUntil,
      redeemed: false,
      usedOrder: null,
      replacedBy: null,
      autoRedeemed: false,
      notUsedIn: [...new Set([...(known.notUsedIn ?? []), ...(known.usedOrder ? [known.usedOrder] : [])])],
    };
    const others = list.filter((x) => x.number !== number);
    // its rest voucher no longer points back to it
    const rest = known.replacedBy ? others.find((x) => x.number === known.replacedBy) : undefined;
    if (rest) rest.useResolved = true;
    const next = [...others, restored];
    setSetting("vouchers", next);
    setSetting("vouchersDeleted", deleted.filter((x) => x.number !== number));
    return { vouchers: next, restored: known };
  }
  const next = [...list, { number, value, validUntil: v.validUntil ?? inOneYear(), orderNumber: null, receivedAt: new Date().toISOString(), redeemed: false }];
  setSetting("vouchers", next);
  return { vouchers: next, restored: null };
}

/** DB vouchers are valid for a year from issue (yyyy-MM-dd, Berlin). */
export function inOneYear(now = new Date()): string {
  const [y, m, d] = now.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).split("-").map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10); // 29.02. → 01.03.
}

/** Removed from the list, but kept aside so the number alone can bring it back (see addVoucher). */
export function deleteVoucher(number: string): Voucher[] {
  const all = getVouchers();
  const gone = all.find((v) => v.number === number);
  const list = all.filter((v) => v.number !== number);
  setSetting("vouchers", list);
  if (gone) setSetting("vouchersDeleted", [...(getSetting<Voucher[]>("vouchersDeleted") ?? []).filter((v) => v.number !== number), gone]);
  return list;
}

/**
 * Work out which vouchers paid for which bookings (DB's mails don't say):
 * clear cases are marked redeemed, the rest comes back as questions.
 */
export function applyVoucherUse(): VoucherQuestion[] {
  const orders = new Map<string, VoucherBooking>();
  for (const t of db.select().from(trips).all()) {
    // replacement journeys share the order — the booking is the original trip
    if (!t.orderNumber || t.price == null || t.movedFrom || t.source === "copy" || t.source === "replacement") continue;
    const prev = orders.get(t.orderNumber);
    const date = prev && prev.date < t.date ? prev.date : t.date;
    orders.set(t.orderNumber, { orderNumber: t.orderNumber, price: t.price, date, bookedAt: `${date}T23:59:59.000Z` });
  }
  const { redeem, questions } = inferVoucherUse(getVouchers(), [...orders.values()]);
  for (const r of redeem) updateVoucher(r.number, { redeemed: true, autoRedeemed: true, usedOrder: r.order, replacedBy: r.replacedBy });
  return questions;
}
