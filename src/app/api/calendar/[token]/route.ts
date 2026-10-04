import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { buildCalendar, tokenOk } from "@/lib/trips/calendarFeed";

export const runtime = "nodejs";

/** Public on purpose (calendar apps can't log in) — the token is the secret. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  ensureReady();
  const token = (await params).token.replace(/\.ics$/, "");
  if (!tokenOk(token)) return new NextResponse("not found", { status: 404 });
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? (/^(localhost|127\.)/.test(host) ? "http" : "https");
  const base = `${proto}://${host}`;
  return new NextResponse(buildCalendar(base), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="bahnreisen.ics"',
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}
