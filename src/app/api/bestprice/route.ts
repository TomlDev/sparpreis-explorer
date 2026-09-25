import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { DB_DAILY_CAP } from "@/lib/config";
import { getPricingProvider } from "@/lib/rail/provider";
import { getProfile } from "@/lib/routeProfiles";
import { addDbUsageToday, dbUsageToday, getPreferences } from "@/lib/repo/settings";
import { localDeparture } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function addDays(date: string, n: number): string {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Cheapest DB best price per day for a route profile — powers the calendar. */
export async function GET(req: Request) {
  ensureReady();
  const url = new URL(req.url);
  const originKey = url.searchParams.get("originKey") || "";
  const destKey = url.searchParams.get("destKey") || "";
  const date = url.searchParams.get("date") || "";
  const days = Math.max(1, Math.min(14, Number(url.searchParams.get("days") || 7)));
  const list = Array.from({ length: days }, (_, i) => addDays(date, i));

  const pricing = getPricingProvider();
  const origin = getProfile(originKey)?.stations.find((s) => s.priority === 0);
  const dest = getProfile(destKey)?.stations.find((s) => s.priority === 0);

  if (!pricing || !pricing.searchBestPrices || !origin || !dest) {
    return NextResponse.json({ days: list.map((d) => ({ date: d, price: null })) });
  }

  const prefs = getPreferences();
  try {
    const resolve = async (name: string) => {
      const hits = await pricing.searchLocations(name, { results: 3 });
      return hits[0]?.id ?? null;
    };
    const [dbOrigin, dbDest] = await Promise.all([
      resolve(origin.stationName),
      resolve(dest.stationName),
    ]);
    if (!dbOrigin || !dbDest) {
      return NextResponse.json({ days: list.map((d) => ({ date: d, price: null })) });
    }

    const out = await Promise.all(
      list.map(async (d) => {
        if (dbUsageToday() >= DB_DAILY_CAP) return { date: d, price: null };
        addDbUsageToday(1);
        try {
          const bp = await pricing.searchBestPrices!(dbOrigin, dbDest, {
            departure: localDeparture(d, "morning"),
            results: 6,
            klasse: prefs.klasse,
            bahncard: prefs.bahncard,
            deutschlandTicket: prefs.deutschlandTicket,
          });
          const prices = bp
            .map((j) => j.price?.amount)
            .filter((p): p is number => typeof p === "number");
          return { date: d, price: prices.length ? Math.min(...prices) : null };
        } catch {
          return { date: d, price: null };
        }
      }),
    );
    return NextResponse.json({ days: out });
  } catch {
    return NextResponse.json({ days: list.map((d) => ({ date: d, price: null })) });
  }
}
