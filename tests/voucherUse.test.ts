import { describe, expect, it } from "vitest";
import type { Voucher } from "@/lib/trips/serviceMail";
import { inferVoucherUse, type VoucherBooking } from "@/lib/trips/voucherUse";

const v = (number: string, value: number, o: Partial<Voucher> = {}): Voucher => ({
  number,
  value,
  validUntil: "2030-11-27",
  orderNumber: null,
  receivedAt: "2026-04-01T10:00:00.000Z",
  redeemed: false,
  ...o,
});
const b = (orderNumber: string, price: number, date = "2026-04-06"): VoucherBooking => ({ orderNumber, price, date, bookedAt: `${date}T23:59:59.000Z` });

describe("Welcher Gutschein hat bezahlt?", () => {
  it("Rest-Gutschein + Preis = genau ein offener Gutschein → automatisch eingelöst", () => {
    const list = [v("AAA1111", 19.77), v("BBB2222", 10.32, { orderNumber: "900001", receivedAt: "2026-04-08T10:00:00.000Z" })];
    expect(inferVoucherUse(list, [b("900001", 9.45)]).redeem).toEqual([{ number: "AAA1111", order: "900001", replacedBy: "BBB2222" }]);
  });

  it("mehrere gleich hohe Kandidaten → Rückfrage; einer schon abgehakt → erledigt", () => {
    const rest = v("REST001", 75.21, { orderNumber: "900002", receivedAt: "2026-10-10T10:00:00.000Z" });
    const hundreds = [v("H000001", 100), v("H000002", 100), v("H000003", 100)];
    const r = inferVoucherUse([...hundreds, rest], [b("900002", 24.79, "2026-10-15")]);
    expect(r.redeem).toEqual([]);
    expect(r.questions).toEqual([
      { kind: "which", orderNumber: "900002", date: "2026-10-15", price: 24.79, rest: "REST001", restValue: 75.21, candidates: ["H000001", "H000002", "H000003"] },
    ]);
    // the user ticked one of them → nothing left to ask
    const ticked = [{ ...hundreds[0], redeemed: true }, hundreds[1], hundreds[2], rest];
    expect(inferVoucherUse(ticked, [b("900002", 24.79)]).questions).toEqual([]);
    // "keiner davon" → not asked again
    expect(inferVoucherUse([...hundreds, { ...rest, useResolved: true }], [b("900002", 24.79)]).questions).toEqual([]);
  });

  it("kein Rest, aber die Buchung kostet genau einen offenen Gutschein → Hinweis (bis man nein sagt)", () => {
    const list = [v("CCC3333", 44.79)];
    expect(inferVoucherUse(list, [b("900003", 44.79)]).questions).toEqual([
      { kind: "used", orderNumber: "900003", date: "2026-04-06", price: 44.79, voucher: "CCC3333" },
    ]);
    expect(inferVoucherUse([{ ...list[0], notUsedIn: ["900003"] }], [b("900003", 44.79)]).questions).toEqual([]);
    // a voucher can't have paid for a trip before it existed
    expect(inferVoucherUse([{ ...list[0], receivedAt: "2026-05-01T00:00:00.000Z" }], [b("900003", 44.79)]).questions).toEqual([]);
  });
});
