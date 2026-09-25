import { eq, like } from "drizzle-orm";
import { db } from "@/db/client";
import { locations } from "@/db/schema";
import { now } from "@/db/util";
import { TTL } from "@/lib/config";
import type { NormLocation } from "@/lib/rail/types";

export function upsertLocation(loc: NormLocation, source = "dbvendo"): void {
  const ts = now();
  db.insert(locations)
    .values({
      id: loc.id,
      name: loc.name,
      type: loc.type ?? null,
      lat: loc.lat ?? null,
      lng: loc.lng ?? null,
      source,
      fetchedAt: ts,
      lastConfirmedAt: ts,
    })
    .onConflictDoUpdate({
      target: locations.id,
      set: { name: loc.name, type: loc.type ?? null, lastConfirmedAt: ts },
    })
    .run();
}

export function getLocation(id: string) {
  return db.select().from(locations).where(eq(locations.id, id)).get();
}

/** Fresh cached location lookups by name prefix (avoids re-querying provider). */
export function cachedLocationsByName(q: string) {
  const rows = db
    .select()
    .from(locations)
    .where(like(locations.name, `%${q}%`))
    .limit(8)
    .all();
  const cutoff = now() - TTL.location;
  return rows.filter((r) => r.lastConfirmedAt > cutoff);
}
