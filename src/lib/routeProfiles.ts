import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { profileStations, routeProfiles } from "@/db/schema";
import { newId, now } from "@/db/util";
import { getSetting, setSetting } from "./repo/settings";

export interface ProfileStation {
  id: string;
  stationName: string;
  query: string | null;
  locationId: string | null;
  priority: number;
  resolved: boolean;
  enabled: boolean;
}

export interface RouteProfile {
  id: string;
  key: string;
  label: string;
  stations: ProfileStation[];
}

interface DefaultRoute {
  originKey: string;
  destKey: string;
}

/** Seed the two corridor profiles the tool is built around, if empty. */
export function ensureDefaultProfiles(): void {
  const count = db.select().from(routeProfiles).all().length;
  if (count > 0) return;
  const ts = now();

  const nrwId = newId("rp");
  db.insert(routeProfiles)
    .values({ id: nrwId, key: "nrw", label: "NRW (Bochum)", createdAt: ts })
    .run();
  db.insert(profileStations)
    .values([
      {
        id: newId("ps"),
        profileId: nrwId,
        locationId: null,
        stationName: "Bochum-Langendreer",
        query: "Bochum-Langendreer",
        priority: 0,
        resolved: false,
      },
      {
        id: newId("ps"),
        profileId: nrwId,
        locationId: null,
        stationName: "Bochum Hbf",
        query: "Bochum Hbf",
        priority: 1,
        resolved: false,
      },
    ])
    .run();

  const swId = newId("rp");
  db.insert(routeProfiles)
    .values({ id: swId, key: "schwarzwald", label: "Schwarzwald (Triberg)", createdAt: ts })
    .run();
  db.insert(profileStations)
    .values({
      id: newId("ps"),
      profileId: swId,
      locationId: null,
      stationName: "Triberg",
      query: "Triberg",
      priority: 0,
      resolved: false,
    })
    .run();

  setSetting<DefaultRoute>("defaultRoute", { originKey: "nrw", destKey: "schwarzwald" });
}

export function listProfiles(): RouteProfile[] {
  const profiles = db.select().from(routeProfiles).all();
  return profiles.map((p) => ({
    id: p.id,
    key: p.key,
    label: p.label,
    stations: stationsFor(p.id),
  }));
}

function stationsFor(profileId: string): ProfileStation[] {
  return db
    .select()
    .from(profileStations)
    .where(eq(profileStations.profileId, profileId))
    .orderBy(asc(profileStations.priority))
    .all()
    .map((s) => ({
      id: s.id,
      stationName: s.stationName,
      query: s.query,
      locationId: s.locationId,
      priority: s.priority,
      resolved: s.resolved,
      enabled: s.enabled,
    }));
}

export function getProfile(key: string): RouteProfile | null {
  const p = db.select().from(routeProfiles).where(eq(routeProfiles.key, key)).get();
  if (!p) return null;
  return { id: p.id, key: p.key, label: p.label, stations: stationsFor(p.id) };
}

export function getProfileById(id: string): RouteProfile | null {
  const p = db.select().from(routeProfiles).where(eq(routeProfiles.id, id)).get();
  if (!p) return null;
  return { id: p.id, key: p.key, label: p.label, stations: stationsFor(p.id) };
}

export function getDefaultRoute(): { origin: RouteProfile; destination: RouteProfile } | null {
  const dr = getSetting<DefaultRoute>("defaultRoute");
  if (!dr) return null;
  const origin = getProfile(dr.originKey);
  const destination = getProfile(dr.destKey);
  if (!origin || !destination) return null;
  return { origin, destination };
}

export function setDefaultRoute(originKey: string, destKey: string): void {
  setSetting<DefaultRoute>("defaultRoute", { originKey, destKey });
}

export function createProfile(key: string, label: string): RouteProfile {
  const id = newId("rp");
  db.insert(routeProfiles).values({ id, key, label, createdAt: now() }).run();
  return { id, key, label, stations: [] };
}

export function addStation(
  profileId: string,
  stationName: string,
  query: string | null,
  locationId: string | null,
): ProfileStation {
  const existing = stationsFor(profileId);
  const priority = existing.length;
  const station: ProfileStation = {
    id: newId("ps"),
    stationName,
    query,
    locationId,
    priority,
    resolved: !!locationId,
    enabled: true,
  };
  db.insert(profileStations)
    .values({
      id: station.id,
      profileId,
      locationId,
      stationName,
      query,
      priority,
      resolved: !!locationId,
    })
    .run();
  return station;
}

/** Attach a resolved provider location id to a profile station. */
export function resolveStation(stationId: string, locationId: string, stationName?: string): void {
  db.update(profileStations)
    .set({
      locationId,
      resolved: true,
      ...(stationName ? { stationName } : {}),
    })
    .where(eq(profileStations.id, stationId))
    .run();
}

export function removeStation(stationId: string): void {
  db.delete(profileStations).where(eq(profileStations.id, stationId)).run();
}

/** Enable/disable a station without deleting it (disabled = skipped in search). */
export function setStationEnabled(stationId: string, enabled: boolean): void {
  db.update(profileStations).set({ enabled }).where(eq(profileStations.id, stationId)).run();
}

/** Move a station up/down within its profile (reorders primary ↔ fallbacks by
 *  rewriting all priorities to a contiguous 0..n after the swap). */
export function moveStation(stationId: string, dir: "up" | "down"): void {
  const st = db.select().from(profileStations).where(eq(profileStations.id, stationId)).get();
  if (!st) return;
  const siblings = db
    .select()
    .from(profileStations)
    .where(eq(profileStations.profileId, st.profileId))
    .orderBy(asc(profileStations.priority))
    .all();
  const idx = siblings.findIndex((s) => s.id === stationId);
  const swapIdx = dir === "up" ? idx - 1 : idx + 1;
  if (idx < 0 || swapIdx < 0 || swapIdx >= siblings.length) return;
  const order = siblings.map((s) => s.id);
  [order[idx], order[swapIdx]] = [order[swapIdx], order[idx]];
  order.forEach((id, i) =>
    db.update(profileStations).set({ priority: i }).where(eq(profileStations.id, id)).run(),
  );
}

/** Primary + ordered fallback stations of a profile that already have a
 *  resolved location id (only those can be searched live). */
export function searchableStations(profile: RouteProfile): ProfileStation[] {
  return profile.stations.filter((s) => s.enabled && s.resolved && s.locationId);
}
