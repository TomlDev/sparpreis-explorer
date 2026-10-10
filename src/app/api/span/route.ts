import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { DB_DAILY_CAP } from "@/lib/config";
import { annotateReliability } from "@/lib/delay";
import { checkOfferSpan } from "@/lib/engine/spanCheck";
import { loadResults } from "@/lib/repo/journeys";
import { addDbUsageToday, dbUsageToday } from "@/lib/repo/settings";

export const runtime = "nodejs";

/** { fingerprint, travelDate } → the result with DB's checked ticket span ("Gilt nur für …"). */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as { fingerprint?: string; travelDate?: string };
  const fp = String(b.fingerprint ?? "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(b.travelDate)) ? String(b.travelDate) : null;
  const [r] = loadResults([fp]);
  if (!r || !day) return NextResponse.json({ error: "Verbindung nicht gefunden" }, { status: 404 });
  if (r.coverage.spanChecked) return NextResponse.json({ result: r });
  if (dbUsageToday() >= DB_DAILY_CAP) return NextResponse.json({ error: "Tageslimit DB-Abfragen erreicht" }, { status: 429 });
  try {
    addDbUsageToday(1);
    const ok = await checkOfferSpan(r, day);
    if (!ok) return NextResponse.json({ error: "Die DB hat keinen Geltungsbereich geliefert – bitte bei DB prüfen" }, { status: 502 });
    annotateReliability([r], day);
    return NextResponse.json({ result: r });
  } catch (e) {
    return NextResponse.json({ error: `DB nicht erreichbar: ${(e as Error).message.slice(0, 120)}` }, { status: 502 });
  }
}
