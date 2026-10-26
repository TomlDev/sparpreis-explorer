import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { addVoucher, applyVoucherUse, deleteVoucher, getVouchers, updateVoucher } from "@/lib/trips/serviceMail";

export const runtime = "nodejs";

/** Vouchers + what's still open about which one paid for a booking (clear cases are marked on the way). */
export async function GET() {
  ensureReady();
  const questions = applyVoucherUse();
  return NextResponse.json({ vouchers: getVouchers(), questions });
}

/** add | update (value, valid until, redeemed) | delete | used (paid for an order) | notUsed | resolve (none of them) */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const number = typeof b.number === "string" ? b.number : "";
  const day = (v: unknown) => (v === null ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const value = typeof b.value === "number" && Number.isFinite(b.value) ? Math.round(b.value * 100) / 100 : undefined;
  try {
    if (b.action === "add") return NextResponse.json({ vouchers: addVoucher({ number, value: value ?? 0, validUntil: day(b.validUntil) ?? null }) });
    if (b.action === "delete") return NextResponse.json({ vouchers: deleteVoucher(number) });
    const order = typeof b.order === "string" ? b.order : null;
    const answered = () => NextResponse.json({ vouchers: getVouchers(), questions: applyVoucherUse() });
    if (b.action === "used") {
      updateVoucher(number, { redeemed: true, usedOrder: order, replacedBy: typeof b.replacedBy === "string" ? b.replacedBy : null });
      return answered();
    }
    if (b.action === "notUsed" && order) {
      const v = getVouchers().find((x) => x.number === number);
      updateVoucher(number, { notUsedIn: [...new Set([...(v?.notUsedIn ?? []), order])] });
      return answered();
    }
    if (b.action === "resolve") {
      updateVoucher(number, { useResolved: true });
      return answered();
    }
    return NextResponse.json({
      vouchers: updateVoucher(number, {
        value,
        validUntil: day(b.validUntil),
        redeemed: typeof b.redeemed === "boolean" ? b.redeemed : undefined,
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
