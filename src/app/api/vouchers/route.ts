import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { addVoucher, deleteVoucher, getVouchers, updateVoucher } from "@/lib/trips/serviceMail";

export const runtime = "nodejs";

export async function GET() {
  ensureReady();
  return NextResponse.json({ vouchers: getVouchers() });
}

/** add | update (value, valid until, redeemed) | delete */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const number = typeof b.number === "string" ? b.number : "";
  const day = (v: unknown) => (v === null ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const value = typeof b.value === "number" && Number.isFinite(b.value) ? Math.round(b.value * 100) / 100 : undefined;
  try {
    if (b.action === "add") return NextResponse.json({ vouchers: addVoucher({ number, value: value ?? 0, validUntil: day(b.validUntil) ?? null }) });
    if (b.action === "delete") return NextResponse.json({ vouchers: deleteVoucher(number) });
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
