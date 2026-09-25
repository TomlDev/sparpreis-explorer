import { eq, lt } from "drizzle-orm";
import { db } from "@/db/client";
import { providerCache } from "@/db/schema";
import { now } from "@/db/util";
import { TTL, type CacheKind } from "@/lib/config";

export interface CacheEntry<T> {
  payload: T | null;
  isError: boolean;
  errorInfo: string | null;
  fetchedAt: number;
  expiresAt: number;
  /** true when past its TTL but still available for stale-while-revalidate. */
  stale: boolean;
}

export function cacheGet<T>(key: string): CacheEntry<T> | null {
  const row = db
    .select()
    .from(providerCache)
    .where(eq(providerCache.cacheKey, key))
    .get();
  if (!row) return null;
  return {
    payload: (row.payload as T) ?? null,
    isError: row.isError,
    errorInfo: row.errorInfo ?? null,
    fetchedAt: row.fetchedAt,
    expiresAt: row.expiresAt,
    stale: row.expiresAt < now(),
  };
}

export function cacheSet<T>(
  key: string,
  kind: CacheKind | string,
  payload: T | null,
  ttlMs: number,
  opts: { provider?: string; isError?: boolean; errorInfo?: string } = {},
): void {
  const ts = now();
  db.insert(providerCache)
    .values({
      cacheKey: key,
      kind: String(kind),
      provider: opts.provider ?? "dbvendo",
      payload: payload as unknown,
      isError: opts.isError ?? false,
      errorInfo: opts.errorInfo ?? null,
      fetchedAt: ts,
      expiresAt: ts + ttlMs,
    })
    .onConflictDoUpdate({
      target: providerCache.cacheKey,
      set: {
        kind: String(kind),
        payload: payload as unknown,
        isError: opts.isError ?? false,
        errorInfo: opts.errorInfo ?? null,
        fetchedAt: ts,
        expiresAt: ts + ttlMs,
      },
    })
    .run();
}

/**
 * Stale-while-revalidate wrapper for a raw provider fetch. Returns the cached
 * value immediately if fresh; if stale (or missing) it awaits the fetcher, but
 * on fetch failure falls back to the stale value when available.
 */
export async function swrFetch<T>(
  key: string,
  kind: CacheKind,
  fetcher: () => Promise<T>,
): Promise<{ value: T | null; fetchedAt: number; stale: boolean; fromCache: boolean }> {
  const entry = cacheGet<T>(key);
  if (entry && !entry.isError && !entry.stale) {
    return { value: entry.payload, fetchedAt: entry.fetchedAt, stale: false, fromCache: true };
  }
  try {
    const value = await fetcher();
    cacheSet(key, kind, value, TTL[kind]);
    return { value, fetchedAt: now(), stale: false, fromCache: false };
  } catch (err) {
    if (entry && entry.payload != null) {
      return { value: entry.payload, fetchedAt: entry.fetchedAt, stale: true, fromCache: true };
    }
    // Negative cache to avoid hammering on repeated failures.
    cacheSet(key, "error", null, TTL.error, {
      isError: true,
      errorInfo: (err as Error).message,
    });
    throw err;
  }
}

/** Delete expired provider-cache rows. Returns count removed. */
export function pruneCache(): number {
  const res = db.delete(providerCache).where(lt(providerCache.expiresAt, now())).run();
  return res.changes ?? 0;
}
