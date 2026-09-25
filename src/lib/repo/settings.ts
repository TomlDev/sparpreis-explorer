import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { appSettings } from "@/db/schema";
import { now } from "@/db/util";

export function getSetting<T>(key: string): T | null {
  const row = db.select().from(appSettings).where(eq(appSettings.key, key)).get();
  return row ? ((row.value as T) ?? null) : null;
}

export function setSetting<T>(key: string, value: T): void {
  db.insert(appSettings)
    .values({ key, value: value as unknown, updatedAt: now() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: value as unknown, updatedAt: now() },
    })
    .run();
}

export interface AppPreferences {
  bahncard: string | null;
  passengers: number;
  klasse: 1 | 2;
  autoCache: boolean;
  deutschlandTicket: boolean;
}

const DEFAULT_PREFS: AppPreferences = {
  bahncard: null,
  passengers: 1,
  klasse: 2,
  autoCache: true,
  deutschlandTicket: false,
};

export function getPreferences(): AppPreferences {
  return { ...DEFAULT_PREFS, ...(getSetting<Partial<AppPreferences>>("prefs") ?? {}) };
}

export function setPreferences(p: Partial<AppPreferences>): AppPreferences {
  const merged = { ...getPreferences(), ...p };
  setSetting("prefs", merged);
  return merged;
}

// ---- daily DB-usage counter (Europe/Berlin day key) ----
import { todayLocal } from "@/lib/time";

function usageKey(): string {
  return `dbUsage:${todayLocal()}`;
}

export function dbUsageToday(): number {
  return getSetting<number>(usageKey()) ?? 0;
}

export function addDbUsageToday(n = 1): void {
  setSetting(usageKey(), dbUsageToday() + n);
}

// ---- attempted pricing "vias" per route+date, so we never re-price the same
// boarding station and can tell when there is genuinely nothing more to fetch ----
export function getAttemptedVias(routeKey: string): string[] {
  return getSetting<string[]>(`vias:${routeKey}`) ?? [];
}

export function addAttemptedVias(routeKey: string, vias: string[]): void {
  if (!vias.length) return;
  const set = new Set(getAttemptedVias(routeKey));
  for (const v of vias) set.add(v);
  setSetting(`vias:${routeKey}`, [...set]);
}
