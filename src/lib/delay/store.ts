import type BetterSqlite3 from "better-sqlite3";
import { sqlite } from "@/db/client";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { evaFromId, normStationKey } from "./normalize";
import {
  DEFAULT_WEIGHTS,
  type DelayBuildParams,
  type DelayWeights,
  type StatLevel,
  type StatRow,
} from "./types";

export * from "./types";

/** Prepared statements are reused (not re-created per call) — cheaper, and
 *  keeps statement garbage out of the hot search path. */
type Stmt = BetterSqlite3.Statement<unknown[], unknown>;
const statements = new Map<string, Stmt>();
export function stmt(sql: string): Stmt {
  let s = statements.get(sql);
  if (!s) statements.set(sql, (s = sqlite.prepare(sql)));
  return s;
}

/**
 * Read side of the punctuality data: which build is active, the query-time
 * weighting, station → EVA resolution and (cached) statistics lookups.
 * Everything here is cheap after the first hit — searches never re-read or
 * re-parse the raw open data.
 */

export function getWeights(): DelayWeights {
  return { ...DEFAULT_WEIGHTS, ...(getSetting<Partial<DelayWeights>>("delay:weights") ?? {}) };
}

export function setWeights(w: Partial<DelayWeights>): DelayWeights {
  const cur = getWeights();
  const clamp = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  const next: DelayWeights = {
    halfLifeMonths: clamp(w.halfLifeMonths, 0.5, 36, cur.halfLifeMonths),
    seasonBoost: clamp(w.seasonBoost, 1, 5, cur.seasonBoost),
    matchWeekday: typeof w.matchWeekday === "boolean" ? w.matchWeekday : cur.matchWeekday,
    minSamples: Math.round(clamp(w.minSamples, 1, 200, cur.minSamples)),
  };
  setSetting("delay:weights", next);
  resetDelayCache();
  return next;
}

export function getActiveBuildId(): string | null {
  return getSetting<string>("delay:activeBuild");
}

export function setActiveBuildId(id: string | null): void {
  setSetting("delay:activeBuild", id);
  resetDelayCache();
}

// ---- caches (per active build; reset on build/weights change) ----
interface Cache {
  buildId: string | null;
  stats: Map<string, StatRow[]>;
  stations: Map<string, string | null>;
  version: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __delayCache: Cache | undefined;
}

function cache(): Cache {
  // The active build id only changes through setActiveBuildId (same process),
  // so it is read once and kept with the cache.
  return (globalThis.__delayCache ??= {
    buildId: getActiveBuildId(),
    stats: new Map(),
    stations: new Map(),
    version: 1,
  });
}

export function resetDelayCache(): void {
  const version = (globalThis.__delayCache?.version ?? 0) + 1;
  globalThis.__delayCache = { buildId: getActiveBuildId(), stats: new Map(), stations: new Map(), version };
}

/** Changes whenever build or weights change — part of the reliability memo key. */
export function delayCacheVersion(): number {
  return cache().version;
}

/** Station → EVA (id first, then exact name, then loose name if unambiguous). */
export function resolveEva(id: string | null | undefined, name: string): string | null {
  const direct = evaFromId(id);
  if (direct) return direct;
  const c = cache();
  if (!c.buildId) return null;
  const k = `${id ?? ""}|${name}`;
  if (c.stations.has(k)) return c.stations.get(k)!;
  let eva: string | null = null;
  const exact = stmt("SELECT DISTINCT eva FROM delay_stations WHERE build_id = ? AND norm = ? LIMIT 2")
    .all(c.buildId, normStationKey(name)) as { eva: string }[];
  if (exact.length === 1) eva = exact[0].eva;
  else if (exact.length === 0) {
    const loose = stmt("SELECT DISTINCT eva FROM delay_stations WHERE build_id = ? AND loose = ? LIMIT 2")
      .all(c.buildId, normStationKey(name, true)) as { eva: string }[];
    if (loose.length === 1) eva = loose[0].eva;
  }
  c.stations.set(k, eva);
  return eva;
}

/** All month × weekday rows for one (level, station, key) of the active build. */
export function statRows(level: StatLevel, eva: string, key: string): StatRow[] {
  const c = cache();
  if (!c.buildId) return [];
  const k = `${level}|${eva}|${key}`;
  const hit = c.stats.get(k);
  if (hit) return hit;
  const rows = (
    stmt(
        "SELECT month, dow, n, cancelled, arr_hist, dep_hist FROM delay_stats WHERE build_id = ? AND level = ? AND eva = ? AND key = ?",
      )
      .all(c.buildId, level, eva, key) as {
      month: string;
      dow: string;
      n: number;
      cancelled: number;
      arr_hist: string;
      dep_hist: string;
    }[]
  ).map((r) => ({
    month: r.month,
    dow: r.dow,
    n: r.n,
    cancelled: r.cancelled,
    arr: JSON.parse(r.arr_hist) as [number, number][],
    dep: JSON.parse(r.dep_hist) as [number, number][],
  }));
  if (c.stats.size > 20000) c.stats.clear();
  c.stats.set(k, rows);
  return rows;
}

export interface BuildInfo {
  id: string;
  status: string;
  params: DelayBuildParams;
  months: string[];
  stations: number;
  rows: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

function toInfo(r: Record<string, unknown>): BuildInfo {
  return {
    id: r.id as string,
    status: r.status as string,
    params: JSON.parse(r.params as string),
    months: JSON.parse(r.months as string),
    stations: r.stations as number,
    rows: r.rows as number,
    error: (r.error as string) ?? null,
    startedAt: r.started_at as number,
    finishedAt: (r.finished_at as number) ?? null,
  };
}

export function buildInfo(id: string | null): BuildInfo | null {
  if (!id) return null;
  const r = stmt("SELECT * FROM delay_builds WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? toInfo(r) : null;
}

export function lastFailedBuild(): BuildInfo | null {
  const r = stmt("SELECT * FROM delay_builds WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return r ? toInfo(r) : null;
}

/** Months of the active build (cached with the other lookups). */
export function activeMonths(): string[] {
  const c = cache() as Cache & { months?: string[] };
  if (!c.months) c.months = buildInfo(c.buildId)?.months ?? [];
  return c.months;
}

export function hasDelayData(): boolean {
  return !!cache().buildId;
}
