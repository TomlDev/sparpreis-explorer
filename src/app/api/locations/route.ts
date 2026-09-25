import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getProvider } from "@/lib/rail/provider";
import { cachedLocationsByName, upsertLocation } from "@/lib/repo/locations";

export const runtime = "nodejs";

export async function GET(req: Request) {
  ensureReady();
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return NextResponse.json({ locations: [] });

  // Prefer cached (very long TTL) to avoid provider calls.
  const cached = cachedLocationsByName(q);
  if (cached.length >= 3) {
    return NextResponse.json({
      locations: cached.map((c) => ({ id: c.id, name: c.name, type: c.type, lat: c.lat, lng: c.lng })),
      source: "cache",
    });
  }

  try {
    const hits = await getProvider().searchLocations(q, { results: 8 });
    for (const h of hits) upsertLocation(h);
    return NextResponse.json({ locations: hits, source: "live" });
  } catch {
    return NextResponse.json({
      locations: cached.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      source: "cache",
      degraded: true,
    });
  }
}
