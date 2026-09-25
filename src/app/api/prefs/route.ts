import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getPreferences, setPreferences, type AppPreferences } from "@/lib/repo/settings";

export const runtime = "nodejs";

export async function GET() {
  ensureReady();
  return NextResponse.json({ prefs: getPreferences() });
}

export async function POST(req: Request) {
  ensureReady();
  const body = (await req.json().catch(() => ({}))) as Partial<AppPreferences>;
  const patch: Partial<AppPreferences> = {};
  if (body.bahncard !== undefined) patch.bahncard = body.bahncard || null;
  if (body.klasse === 1 || body.klasse === 2) patch.klasse = body.klasse;
  if (typeof body.passengers === "number") patch.passengers = Math.max(1, Math.min(5, body.passengers));
  if (typeof body.autoCache === "boolean") patch.autoCache = body.autoCache;
  if (typeof body.deutschlandTicket === "boolean") patch.deutschlandTicket = body.deutschlandTicket;
  return NextResponse.json({ prefs: setPreferences(patch) });
}
