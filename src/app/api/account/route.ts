import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getPreferences, setPreferences } from "@/lib/repo/settings";
import { calendarToken } from "@/lib/trips/calendarFeed";
import { activeBahnCard, deleteBahnCard, getBahnCards, getPoints, getPromos, reminders, updateBahnCard } from "@/lib/trips/loyalty";

export const runtime = "nodejs";

const mask = (n: string | null) => (n ? `${n.slice(0, 4)} •••• ${n.slice(-4)}` : null);

function view(req: Request) {
  const url = new URL(req.url);
  const host = req.headers.get("host") ?? url.host;
  const proto = /^(localhost|127\.)/.test(host) ? "http" : "https";
  const active = activeBahnCard();
  return {
    bahncards: getBahnCards().map((c) => ({ ...c, number: mask(c.number) })),
    activeBahnCard: active ? { id: active.id, product: active.product, code: `BC${/BahnCard (\d+)/.exec(active.product)?.[1] ?? ""}` } : null,
    prefsBahncard: getPreferences().bahncard,
    points: getPoints(),
    promos: getPromos(),
    reminders: reminders(),
    calendarUrl: `${proto}://${host}/api/calendar/${calendarToken()}.ics`,
  };
}

export async function GET(req: Request) {
  ensureReady();
  return NextResponse.json(view(req));
}

/** updateBahnCard | deleteBahnCard | useBahnCardForSearch | rotateCalendar */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  switch (b.action) {
    case "updateBahnCard":
      if (typeof b.id === "string")
        updateBahnCard(b.id, {
          validUntil: day(b.validUntil),
          cancelBy: day(b.cancelBy),
          autoRenew: typeof b.autoRenew === "boolean" ? b.autoRenew : undefined,
          confirmed: typeof b.confirmed === "boolean" ? b.confirmed : undefined,
          cancelled: typeof b.cancelled === "boolean" ? b.cancelled : undefined,
        });
      break;
    case "deleteBahnCard":
      if (typeof b.id === "string") deleteBahnCard(b.id);
      break;
    case "useBahnCardForSearch": {
      const code = typeof b.code === "string" && /^BC(25|50|100)$/.test(b.code) ? b.code : null;
      setPreferences({ bahncard: code });
      break;
    }
    case "rotateCalendar":
      calendarToken(true);
      break;
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json(view(req));
}
