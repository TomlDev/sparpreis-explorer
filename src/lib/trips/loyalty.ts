import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { claims, trips } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { newId } from "@/db/util";
import { todayLocal } from "@/lib/time";

const berlinDay = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
import { germanDate, getVouchers } from "./serviceMail";

/**
 * The "account" side of DB mail: BahnCards, BahnBonus points and promotions —
 * plus the reminders derived from them (and from trips, claims, vouchers).
 */

// ---------------------------------------------------------------------------
// BahnCard
// ---------------------------------------------------------------------------

export interface BahnCard {
  id: string;
  product: string; // "BahnCard 25 Aktion Herbst 2026"
  number: string | null;
  orderNumber: string | null;
  price: number | null;
  validFrom: string | null; // yyyy-MM-dd
  /** End of validity — assumed (1 year) until confirmed by the user. */
  validUntil: string | null;
  /** Renews automatically unless cancelled in time (DB's usual terms). */
  autoRenew: boolean;
  /** Last day to cancel (usual terms: 6 weeks before the end). */
  cancelBy: string | null;
  /** The user checked end date / terms in the DB account. */
  confirmed: boolean;
  /** Cancelled = won't renew; still valid until validUntil. */
  cancelled: boolean;
  receivedAt: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addYear = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};
const flat = (t: string) => t.replace(/\s+/g, " ").trim();
const euro = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));

export function parseBahnCardOrder(body: string): Partial<BahnCard> | null {
  const t = flat(body);
  if (!/BahnCard-Bestellung|Produkt:\s*BahnCard/i.test(t)) return null;
  const product = /Produkt:\s*(BahnCard[^:]*?)\s+(?:Inhaber|Gültigkeitsbeginn|Gesamtpreis)/.exec(t)?.[1]?.trim();
  if (!product) return null;
  const from = /Gültigkeitsbeginn:\s*(\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1];
  const price = /Gesamtpreis:\s*([\d.]+,\d{2})\s*EUR/.exec(t)?.[1];
  return {
    product,
    orderNumber: /Auftragsnummer:\s*(\d{6,})/.exec(t)?.[1] ?? null,
    validFrom: from ? germanDate(from) : null,
    price: price ? euro(price) : null,
  };
}

export function parseBahnCardService(subject: string, body: string): Partial<BahnCard> | null {
  const kind = /Bestellung einer (?:digitalen )?(BahnCard \d+(?: First)?)/i.exec(subject)?.[1];
  const number = /BahnCard mit der Nummer (\d{10,})/.exec(flat(body))?.[1];
  return kind && number ? { product: kind, number } : null;
}

/** "Bestätigung Ihrer Kündigung": "… Ihre BahnCard 7625 kündigen … Kündigung zum 29.09.2027." */
export function parseBahnCardCancellation(subject: string, body: string): { last4: string; until: string } | null {
  if (!/K(ü|ue)ndigung/i.test(subject)) return null;
  const t = flat(body);
  const last4 = /BahnCard\s+(?:Nr\.?\s*)?(?:\S*?)(\d{4})\b/.exec(t)?.[1];
  const until = /K(?:ü|ue)ndigung zum (\d{2}\.\d{2}\.\d{4})/.exec(t)?.[1];
  return last4 && until ? { last4, until: germanDate(until)! } : null;
}

/** Mark the matching card cancelled; the end date comes from DB → confirmed. */
export function applyBahnCardCancellation(c: { last4: string; until: string }): BahnCard | null {
  const list = getBahnCards();
  const card = list.find((x) => x.number?.endsWith(c.last4)) ?? null;
  if (!card) return null;
  updateBahnCard(card.id, { cancelled: true, validUntil: c.until, confirmed: true });
  return getBahnCards().find((x) => x.id === card.id) ?? null;
}

export const getBahnCards = (): BahnCard[] => getSetting<BahnCard[]>("bahncards") ?? [];

/** "BahnCard 25 Aktion Herbst 2026" → "25" (to pair order + service mail). */
const family = (p: string) => /BahnCard (\d+)/.exec(p)?.[1] ?? p;

export function saveBahnCard(part: Partial<BahnCard>, receivedAt: Date): BahnCard {
  const list = getBahnCards();
  const near = (c: BahnCard) => Math.abs(new Date(c.receivedAt).getTime() - receivedAt.getTime()) < 14 * 86_400_000;
  const match =
    list.find((c) => (part.orderNumber && c.orderNumber === part.orderNumber) || (part.number && c.number === part.number)) ??
    list.find((c) => family(c.product) === family(part.product ?? "") && near(c) && (!c.number || !part.number));
  const card: BahnCard = match ?? {
    id: newId("bc"),
    product: part.product ?? "BahnCard",
    number: null,
    orderNumber: null,
    price: null,
    validFrom: null,
    validUntil: null,
    autoRenew: true,
    cancelBy: null,
    confirmed: false,
    cancelled: false,
    receivedAt: receivedAt.toISOString(),
  };
  // The order mail carries the full product name; the service mail the number.
  if (part.product && (!match || part.product.length > card.product.length)) card.product = part.product;
  card.number = part.number ?? card.number;
  card.orderNumber = part.orderNumber ?? card.orderNumber;
  card.price = part.price ?? card.price;
  if (part.validFrom && !card.confirmed) {
    card.validFrom = part.validFrom;
    card.validUntil = addYear(part.validFrom);
    card.cancelBy = addDays(card.validUntil, -42);
  }
  if (receivedAt.toISOString() < card.receivedAt) card.receivedAt = receivedAt.toISOString();
  setSetting("bahncards", match ? list.map((c) => (c.id === card.id ? card : c)) : [...list, card]);
  return card;
}

export function updateBahnCard(id: string, patch: Partial<Pick<BahnCard, "validUntil" | "autoRenew" | "confirmed" | "cancelled" | "cancelBy">>): BahnCard[] {
  const list = getBahnCards().map((c) => {
    if (c.id !== id) return c;
    // Only the fields given — `{ validUntil: undefined }` must not wipe the date.
    const next = { ...c, ...Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)) };
    // New end date → recompute the cancellation deadline unless given explicitly.
    if (patch.validUntil && patch.cancelBy === undefined) next.cancelBy = addDays(patch.validUntil, -42);
    return next;
  });
  setSetting("bahncards", list);
  return list;
}

export function deleteBahnCard(id: string): BahnCard[] {
  const list = getBahnCards().filter((c) => c.id !== id);
  setSetting("bahncards", list);
  return list;
}

/** The BahnCard valid on `day` (for the price search preference). */
export function activeBahnCard(day = todayLocal()): BahnCard | null {
  // A cancelled card stays valid until its end date (cancelling only stops the renewal).
  return getBahnCards().find((c) => c.validFrom && c.validFrom <= day && (!c.validUntil || c.validUntil >= day)) ?? null;
}

// ---------------------------------------------------------------------------
// BahnBonus points
// ---------------------------------------------------------------------------

export interface PointsBalance {
  asOf: string; // yyyy-MM-dd
  praemien: number;
  status: number;
  expiring: { date: string; points: number } | null;
}

export function parsePoints(body: string): PointsBalance | null {
  const t = flat(body);
  const m = /Punkteübersicht vom (\d{1,2}\.\d{1,2}\.\d{4})\s+([\d.]+)\s+Prämienpunkte\s+([\d.]+)\s+Statuspunkte/.exec(t);
  if (!m) return null;
  const exp = /Verfallende Prämienpunkte zum (\d{1,2}\.\d{1,2}\.\d{4})\s*:\s*([\d.]+)/.exec(t);
  return {
    asOf: germanDate(m[1])!,
    praemien: Number(m[2].replace(/\./g, "")),
    status: Number(m[3].replace(/\./g, "")),
    expiring: exp ? { date: germanDate(exp[1])!, points: Number(exp[2].replace(/\./g, "")) } : null,
  };
}

export const getPoints = (): PointsBalance | null => getSetting<PointsBalance>("bahnbonus");

export function savePoints(p: PointsBalance): void {
  const cur = getPoints();
  if (!cur || p.asOf >= cur.asOf) setSetting("bahnbonus", p);
}

// ---------------------------------------------------------------------------
// Promotions (newsletters)
// ---------------------------------------------------------------------------

export interface Promo {
  subject: string;
  receivedAt: string;
  deadline: string | null;
  snippet: string;
}

const MONTH_NAMES = "Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember";

export function parsePromo(subject: string, body: string, receivedAt: Date): Promo {
  const t = flat(body);
  const year = receivedAt.getUTCFullYear();
  const long = new RegExp(`bis (?:zum )?(\\d{1,2}\\.\\s*(?:${MONTH_NAMES})\\s+\\d{4})`).exec(t)?.[1];
  const short = /(?:Nur bis|bis zum|bis)\s+(\d{1,2})\.(\d{1,2})\.(?!\d)/.exec(t);
  const deadline = long ? germanDate(long) : short ? `${year}-${short[2].padStart(2, "0")}-${short[1].padStart(2, "0")}` : null;
  const start = Math.max(t.search(/Hallo|Guten Tag|Liebe/), 0);
  return {
    subject: subject.replace(/^(?:(?:Fwd?|WG|AW|Re):\s*)+/i, "").trim(),
    receivedAt: receivedAt.toISOString(),
    deadline,
    snippet: t.slice(start, start + 260),
  };
}

export const getPromos = (): Promo[] => getSetting<Promo[]>("promos") ?? [];

export function savePromo(p: Promo): void {
  const list = getPromos().filter((x) => !(x.subject === p.subject && x.receivedAt === p.receivedAt));
  setSetting("promos", [...list, p].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 60));
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface Reminder {
  id: string;
  date: string; // yyyy-MM-dd
  title: string;
  detail: string;
  kind: "bahncard" | "points" | "voucher" | "claim" | "trip";
  href?: string;
}

const isDay = (d: string | null | undefined): d is string =>
  !!d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(`${d}T12:00:00Z`).getTime());

export function reminders(today = todayLocal()): Reminder[] {
  const out: Reminder[] = [];
  for (const c of getBahnCards()) {
    if (!isDay(c.validUntil)) continue;
    const check = c.confirmed ? "" : " (Datum angenommen – bitte im DB-Kundenkonto prüfen)";
    if (c.autoRenew && !c.cancelled && isDay(c.cancelBy))
      out.push({
        id: `bc-cancel-${c.id}`,
        date: c.cancelBy,
        title: `${c.product}: letzter Tag zum Kündigen`,
        detail: `Sonst verlängert sie sich automatisch.${check}`,
        kind: "bahncard",
      });
    out.push({
      id: `bc-end-${c.id}`,
      date: c.validUntil,
      title: `${c.product} läuft ab`,
      detail: c.cancelled
        ? `Gekündigt – danach ohne BahnCard-Rabatt (Preissuche umstellen).${check}`
        : c.autoRenew
          ? `Verlängert sich automatisch, falls nicht gekündigt.${check}`
          : `Danach ohne BahnCard-Rabatt.${check}`,
      kind: "bahncard",
    });
  }
  const pts = getPoints();
  if (pts?.expiring && pts.expiring.points > 0 && isDay(pts.expiring.date))
    out.push({
      id: `pts-${pts.expiring.date}`,
      date: pts.expiring.date,
      title: `${pts.expiring.points.toLocaleString("de-DE")} BahnBonus-Punkte verfallen`,
      detail: `Stand ${pts.asOf}: ${pts.praemien.toLocaleString("de-DE")} Prämienpunkte. Vorher einlösen.`,
      kind: "points",
    });
  for (const voucher of getVouchers().filter((v) => !v.redeemed && isDay(v.validUntil)))
    out.push({
      id: `voucher-${voucher.number}`,
      date: addDays(voucher.validUntil!, -30),
      title: `Gutschein ${voucher.number} läuft in 30 Tagen ab`,
      detail: `${voucher.value.toLocaleString("de-DE", { minimumFractionDigits: 2 })} € – gültig bis ${voucher.validUntil}.`,
      kind: "voucher",
    });
  // Submitted claims without an answer after a month (DB: "innerhalb eines Monats").
  const open = db.select({ claim: claims, trip: trips }).from(claims).innerJoin(trips, eq(claims.tripId, trips.id)).orderBy(desc(claims.submittedAt)).all();
  for (const { claim, trip } of open) {
    if (claim.status !== "submitted" || !claim.submittedAt || !Number.isFinite(claim.submittedAt)) continue;
    out.push({
      id: `claim-${claim.id}`,
      date: addDays(berlinDay(claim.submittedAt), 31),
      title: `Fahrgastrechte${claim.caseId ? ` ${claim.caseId}` : ""}: noch keine Antwort`,
      detail: `Eingereicht am ${new Date(claim.submittedAt).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" })} (${trip.originName} → ${trip.destName}, Fahrt vom ${trip.date.split("-").reverse().join(".")}). Die DB antwortet meist innerhalb eines Monats – sonst beim Servicecenter nachfragen.`,
      kind: "claim",
      href: `/reisen/${trip.id}`,
    });
  }
  // Past trips nobody told the app about.
  for (const t of db.select().from(trips).where(eq(trips.status, "planned")).all()) {
    if (t.date >= today) continue;
    out.push({
      id: `trip-${t.id}`,
      date: t.date,
      title: `Wie lief die Fahrt ${t.originName} → ${t.destName}?`,
      detail: "Eintragen, ob alles pünktlich war – dann sieht die App, ob dir Geld zusteht.",
      kind: "trip",
      href: `/reisen/${t.id}`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
