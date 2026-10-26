import type { Voucher } from "./serviceMail";

/**
 * Which voucher paid for a booking? DB's booking mails only say "per Gutschein",
 * never the number. But when a voucher isn't used up, DB sends a new one for
 * the rest, naming the order it came from:  old voucher = booking price + rest.
 *  - exactly one open voucher fits → it was used (marked automatically);
 *  - several fit (e.g. three 100 € vouchers) → ask which one;
 *  - no rest voucher, but a booking costs exactly an open voucher's value → hint.
 */

export interface VoucherBooking {
  orderNumber: string;
  price: number;
  /** when it was booked / the trip date (yyyy-MM-dd) — for the question's wording */
  date: string;
  /** first seen (ISO) — a voucher can only pay for bookings after it arrived */
  bookedAt: string;
}

export type VoucherQuestion =
  | { kind: "which"; orderNumber: string; date: string; price: number; rest: string; restValue: number; candidates: string[] }
  | { kind: "used"; orderNumber: string; date: string; price: number; voucher: string };

const cents = (x: number) => Math.round(x * 100);

export interface VoucherInference {
  /** voucher numbers to mark redeemed, with what replaced them */
  redeem: { number: string; order: string; replacedBy: string | null }[];
  questions: VoucherQuestion[];
}

export function inferVoucherUse(vouchers: Voucher[], bookings: VoucherBooking[]): VoucherInference {
  const byOrder = new Map(bookings.map((b) => [b.orderNumber, b]));
  const redeem: VoucherInference["redeem"] = [];
  const questions: VoucherQuestion[] = [];
  const taken = new Set<string>();

  // 1) rest vouchers: old = rest + price
  for (const rest of vouchers) {
    if (!rest.orderNumber || rest.useResolved) continue;
    const b = byOrder.get(rest.orderNumber);
    if (!b) continue;
    const fits = vouchers.filter(
      (o) => o.number !== rest.number && o.value != null && o.receivedAt <= rest.receivedAt && cents(o.value) === cents(rest.value) + cents(b.price),
    );
    // already settled: one of them is ticked / linked to this rest voucher
    if (fits.some((o) => o.replacedBy === rest.number || (o.redeemed && !o.replacedBy))) continue;
    const open = fits.filter((o) => !o.redeemed && !taken.has(o.number));
    if (open.length === 1) {
      redeem.push({ number: open[0].number, order: b.orderNumber, replacedBy: rest.number });
      taken.add(open[0].number);
    } else if (open.length > 1) {
      questions.push({ kind: "which", orderNumber: b.orderNumber, date: b.date, price: b.price, rest: rest.number, restValue: rest.value, candidates: open.map((o) => o.number) });
    }
  }

  // 2) no rest voucher: a booking that costs exactly what an open voucher is worth
  const withRest = new Set(vouchers.map((v) => v.orderNumber).filter(Boolean));
  for (const b of bookings) {
    if (withRest.has(b.orderNumber)) continue;
    const v = vouchers.find(
      (o) => !o.redeemed && !taken.has(o.number) && o.value != null && cents(o.value) === cents(b.price) && o.receivedAt <= b.bookedAt && !(o.notUsedIn ?? []).includes(b.orderNumber),
    );
    if (v) questions.push({ kind: "used", orderNumber: b.orderNumber, date: b.date, price: b.price, voucher: v.number });
  }
  return { redeem, questions };
}
