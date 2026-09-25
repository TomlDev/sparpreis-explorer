import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { priceHistory } from "@/lib/repo/journeys";

export const runtime = "nodejs";

export async function GET(req: Request) {
  ensureReady();
  const fp = new URL(req.url).searchParams.get("fp");
  if (!fp) return NextResponse.json({ history: [] });
  const rows = priceHistory(fp, 60).reverse();
  return NextResponse.json({
    history: rows.map((r) => ({
      date: new Date(r.observedAt).toISOString(),
      travelDate: r.travelDate,
      price: r.price,
      coverage: r.coverage,
    })),
  });
}
