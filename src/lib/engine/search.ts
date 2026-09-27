import { eq, like } from "drizzle-orm";
import { db } from "@/db/client";
import { journeyQueries, searchRuns } from "@/db/schema";
import { newId, now } from "@/db/util";
import { DB_BUDGET, DB_DAILY_CAP, DB_JITTER_MS, MOTIS_BUDGET, TTL } from "@/lib/config";
import { addAttemptedVias, addDbUsageToday, dbUsageToday, getAttemptedVias, getPreferences } from "@/lib/repo/settings";
import { isLongDistanceProduct } from "@/lib/domain/products";
import { resolveRichId, searchProforma } from "@/lib/rail/proforma";
import { rankResults } from "@/lib/domain/ranking";
import { buildResult, isOriginalKind, type SearchResult } from "@/lib/domain/result";
import { normStationName } from "@/lib/domain/ticketCoverage";
import {
  getPricingProvider,
  getRoutingProvider,
  providerStatuses,
  type RailProvider,
} from "@/lib/rail/provider";
import { ProviderError, type NormJourney, type ProductFilter } from "@/lib/rail/types";
import { loadResults, saveJourneyResult } from "@/lib/repo/journeys";
import { getProfile, resolveStation, searchableStations, type RouteProfile } from "@/lib/routeProfiles";
import { upsertLocation } from "@/lib/repo/locations";
import { localDeparture } from "@/lib/time";
import { dlog } from "@/lib/log";
import { getInterestingEdges, learnFromJourney } from "./patterns";
import { annotateReliability } from "@/lib/delay";
import { selectForPricing } from "./strategy";
import {
  logDecision,
  observationCounts,
  segmentSignature,
  totalDecisions,
} from "@/lib/repo/decisions";
import {
  type Emit,
  type SearchFilters,
  type SearchMeta,
  type SearchParams,
} from "./types";

interface Endpoint {
  id: string;
  name: string;
  label: string;
  variant: "primary" | "fallback";
}

/** Reverse a search: swap origin/destination profiles and ad-hoc endpoints. */
export function reverseSearchParams(p: SearchParams): SearchParams {
  return {
    ...p,
    originKey: p.destKey,
    destKey: p.originKey,
    originId: p.destId,
    originName: p.destName,
    destId: p.originId,
    destName: p.originName,
  };
}

/** Decide whether to also query the fallback origin (e.g. the town's Hbf). */
export function shouldTryFallback(opts: {
  useFallback: boolean;
  hasFallback: boolean;
  primaryUsable: boolean;
  mode: string;
  requestsUsed: number;
  budget: number;
}): boolean {
  return (
    opts.useFallback &&
    opts.hasFallback &&
    (!opts.primaryUsable || opts.mode !== "fast") &&
    opts.requestsUsed < opts.budget
  );
}

export function buildCacheKey(p: SearchParams): string {
  const origin = p.originKey ?? p.originId ?? "?";
  const dest = p.destKey ?? p.destId ?? "?";
  const parts = [
    origin,
    dest,
    p.travelDate,
    p.timeWindow,
    p.mode,
    p.filters.allowICE ? "ice" : "",
    p.filters.allowIC ? "ic" : "",
    getRoutingProvider().name,
  ];
  // Arrival searches are a different query (departure keys stay unchanged).
  if (p.timeMode === "arrival") parts.push(`arr:${p.timeTo ?? ""}`);
  return parts.join("|");
}

function productFilter(f: SearchFilters): ProductFilter {
  return {
    nationalExpress: f.allowICE,
    national: f.allowIC,
    regionalExpress: true,
    regional: true,
    suburban: true,
    subway: true,
    tram: true,
    bus: true,
    ferry: true,
    taxi: true,
  };
}

/** Filter + require at least one FV leg (the whole point of the tool). Keeps
 *  unpriced/green/yellow; hides proven partial (red)/none when onlyFullTicket. */
export function applyFilters(results: SearchResult[], f: SearchFilters): SearchResult[] {
  const anyPriced = results.some((r) => r.coverage.price != null);
  return results.filter((r) => {
    const m = r.metrics;
    if (f.onlyPriced && anyPriced && r.coverage.price == null) return false;
    if (!f.allowICE && r.legs.some((l) => l.product === "nationalExpress")) return false;
    if (!f.allowIC && r.legs.some((l) => l.product === "national")) return false;
    if (f.onlyFullTicket && (r.coverage.coverage === "red" || r.coverage.coverage === "none"))
      return false;
    if (f.maxPrice != null && r.coverage.price != null && r.coverage.price > f.maxPrice) return false;
    if (f.maxDurationMin != null && m.durationMin > f.maxDurationMin) return false;
    if (f.maxTransfers != null && m.transfers > f.maxTransfers) return false;
    if (f.maxFvMinutes != null && m.fvMinutes > f.maxFvMinutes) return false;
    if (f.maxFvStops != null && m.fvStops > f.maxFvStops) return false;
    if (f.minTransferMin != null && m.minTransferMin != null && m.minTransferMin < f.minTransferMin)
      return false;
    return true;
  });
}

/** Small human-like delay before each DB network call. */
function jitter(): Promise<void> {
  const span = DB_JITTER_MS.max - DB_JITTER_MS.min;
  const ms = DB_JITTER_MS.min + Math.floor(Math.random() * span);
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveEndpoints(profile: RouteProfile, countReq: () => void): Promise<Endpoint[]> {
  const routing = getRoutingProvider();
  const out: Endpoint[] = [];
  for (const st of profile.stations) {
    let locationId = st.locationId;
    let name = st.stationName;
    if (!locationId && st.query) {
      try {
        countReq();
        const hits = await routing.searchLocations(st.query, { results: 5 });
        const best = hits[0];
        if (best) {
          locationId = best.id;
          name = best.name;
          upsertLocation(best, routing.name);
          resolveStation(st.id, best.id, best.name);
        }
      } catch {
        /* leave unresolved */
      }
    }
    if (locationId) {
      out.push({
        id: locationId,
        name,
        label: shortLabel(name, profile.stations.map((s) => s.stationName)),
        variant: st.priority === 0 ? "primary" : "fallback",
      });
    }
  }
  return out;
}

/** Station label without the town all of a profile's stations share
 *  ("Bochum-Langendreer" + "Bochum Hbf" → unchanged; "Essen Steele" + "Essen
 *  Hbf" → "Steele", "Hbf"). No profile context (ad-hoc endpoint) → full name. */
function shortLabel(name: string, siblings: string[]): string {
  if (!siblings.length) return name;
  const town = (s: string) => s.trim().split(/\s+/)[0];
  const t = town(name);
  if (!siblings.every((s) => town(s) === t)) return name;
  return name.trim().slice(t.length).trim() || name;
}

export interface RunOptions {
  emit: Emit;
  signal?: AbortSignal;
}

export async function runSearch(params: SearchParams, opts: RunOptions): Promise<void> {
  const { emit, signal } = opts;
  const routing = getRoutingProvider();
  const pricing = getPricingProvider();
  const motisBudget = MOTIS_BUDGET[params.mode];
  const dbBudget = DB_BUDGET[params.mode];
  let motisUsed = 0;
  let dbUsed = 0; // total DB network calls this search (resolves + price checks)
  let pricedVias = 0; // priced candidates this search (what dbBudget limits)
  const startDailyUsed = dbUsageToday();
  const onDbUse = () => {
    dbUsed++;
    addDbUsageToday(1);
  };
  const onPriced = () => {
    pricedVias++;
  };
  // Budget limits priced candidates; a separate daily cap limits total volume.
  const dailyRemaining = () => DB_DAILY_CAP - (startDailyUsed + dbUsed);
  const effectiveDbBudget = Math.min(dbBudget, DB_DAILY_CAP - startDailyUsed);
  // Phase 2 (alternatives) fetches ALL candidates — bounded only by the daily
  // cap, not the per-search budget — so the user doesn't press "more" repeatedly.
  const alternativesMode = params.stage === "alternatives";
  const canSpend = () =>
    (alternativesMode || pricedVias < dbBudget) && dailyRemaining() > 0 && !signal?.aborted;
  // Shared across both pricing passes so we never re-resolve or re-price a via.
  const dbIdCache = new Map<string, string | null>();
  const seenVia = new Set<string>();
  // Persisted across searches: vias already tried for this route+date, so we
  // never re-price the same boarding station (no wasted budget) and can tell
  // when there is genuinely nothing more to fetch.
  const routeKey = `${params.originKey ?? params.originId ?? "?"}|${params.destKey ?? params.destId ?? "?"}|${params.travelDate}`;
  for (const v of getAttemptedVias(routeKey)) seenVia.add(v);
  // User preferences (BahnCard / class / D-Ticket) applied to price checks.
  const prefs = getPreferences();
  let anchorPrice: number | null = null;
  let anchorDone = false;
  const setAnchor = (p: number | null | undefined) => {
    if (typeof p === "number") anchorPrice = anchorPrice == null ? p : Math.min(anchorPrice, p);
  };
  const cacheKey = buildCacheKey(params);
  const departure = localDeparture(params.travelDate, params.timeWindow);
  // Arrival mode: the window means "arrive between timeWindow and timeTo", so we
  // search "arrive by timeTo" (DB/MOTIS return connections arriving at/before
  // it — incl. slow pro-forma ones that leave early). Phase 2 always anchors on
  // the reference DEPARTURE (alternatives must board the same leading trains).
  const arriveBy = (() => {
    if (params.timeMode !== "arrival" || params.stage === "alternatives") return null;
    const t = localDeparture(params.travelDate, params.timeTo || params.timeWindow);
    // Overnight window (e.g. 23:00–01:00): the end is on the next day.
    return t.getTime() <= departure.getTime() ? new Date(t.getTime() + 24 * 3600_000) : t;
  })();
  /** Time option for every "search at the requested time" call. */
  const timeOpt: { departure?: Date; arrival?: Date } = arriveBy ? { arrival: arriveBy } : { departure };

  // Alternatives must leave around the requested time (the reference departure in
  // phase 2). Keep pricing + discovery anchored here so we don't wander hours off.
  const ANCHOR_AFTER_MIN = 150;
  const ANCHOR_BEFORE_MIN = 90;
  const nearAnchor = (r: SearchResult): boolean => {
    if (arriveBy) {
      // Arrival mode: arrive inside the window (small grace on both ends).
      const iso = r.metrics.plannedArrival;
      if (!iso) return true;
      const t = new Date(iso).getTime();
      return t <= arriveBy.getTime() + 15 * 60000 && t >= departure.getTime() - ANCHOR_BEFORE_MIN * 60000;
    }
    const iso = r.metrics.plannedDeparture;
    if (!iso) return true;
    const d = (new Date(iso).getTime() - departure.getTime()) / 60000;
    return d <= ANCHOR_AFTER_MIN && d >= -ANCHOR_BEFORE_MIN;
  };

  const collected = new Map<string, SearchResult>();
  // bahn.de station ids for the "Bei DB prüfen" deep link (name → {soid, soei}).
  const stationIds: Record<string, { soid: string; soei: string }> = {};
  let candidatesChecked = 0;
  let candidatesTotal = 0;
  let primaryCount = 0;
  let fallbackCount = 0;

  const runId = newId("run");
  db.insert(searchRuns)
    .values({
      id: runId,
      cacheKey,
      mode: params.mode,
      travelDate: params.travelDate,
      startedAt: now(),
      budget: motisBudget + dbBudget,
      status: "running",
    })
    .run();

  const meta = (): SearchMeta => {
    const variants = new Map<string, number>();
    for (const r of collected.values()) {
      if (r.variantLabel) variants.set(r.variantLabel, (variants.get(r.variantLabel) ?? 0) + 1);
    }
    const prices = [...collected.values()].map((r) => r.coverage.price).filter((p): p is number => p != null);
    const st = providerStatuses();
    return {
      stale: false,
      cachedAt: null,
      routingProvider: st.routing.name,
      routingReachable: st.routing.reachable,
      motisUsed,
      motisBudget,
      pricingProvider: st.pricing?.name ?? null,
      priceCheckAvailable: st.priceCheckAvailable,
      dbUsed,
      dbBudget,
      pricedCount: prices.length,
      candidatesChecked,
      candidatesTotal,
      primaryCount,
      fallbackCount,
      bestPrice: prices.length ? Math.min(...prices) : null,
      anchorPrice,
      dailyCapReached: startDailyUsed + dbUsed >= DB_DAILY_CAP,
      priceableRemaining: [...collected.values()].filter(
        (r) =>
          r.coverage.price == null &&
          r.metrics.fvLegs >= 1 &&
          r.headlineFv &&
          !seenVia.has(normStationName(r.headlineFv.fromName)),
      ).length,
      originVariants: [...variants.entries()].map(([label, count]) => ({ label, count })),
      stationIds,
    };
  };

  const snapshot = (): SearchResult[] => {
    // Annotate each result relative to the current anchor (best "normal" price).
    for (const r of collected.values()) {
      const p = r.coverage.price;
      r.savingsVsAnchor = anchorPrice != null && p != null ? Math.round((anchorPrice - p) * 100) / 100 : null;
      r.isProformaWin =
        r.resultKind === "proforma" && p != null && anchorPrice != null && p < anchorPrice;
    }
    annotateReliability(collected.values(), params.travelDate);
    return rankResults(applyFilters([...collected.values()], params.filters), params.sort);
  };

  const ingest = (
    journey: NormJourney,
    variant: "primary" | "fallback",
    variantLabel: string,
    source: SearchResult["source"],
    expected?: { fromName?: string; toName?: string },
    resultKind: SearchResult["resultKind"] = "alternative",
  ): SearchResult | null => {
    if (!journey.legs.length) return null;
    const result = buildResult(journey, {
      variant,
      variantLabel,
      source,
      expected,
      resultKind,
      priceCheckedAt: journey.price ? now() : null,
      timetableAt: now(),
    });
    const prev = collected.get(result.fingerprint);
    if (!prev || betterCoverage(result, prev)) collected.set(result.fingerprint, result);
    // Same fingerprint = same trains. If DB proposed it in a plain search, it
    // stays an "original" connection even when a constructed search re-finds it.
    const kept = collected.get(result.fingerprint)!;
    const originalKind = [prev?.resultKind, result.resultKind].find(isOriginalKind);
    if (originalKind && !isOriginalKind(kept.resultKind)) kept.resultKind = originalKind;
    try {
      saveJourneyResult(params.travelDate, source === "candidate" ? (pricing?.name ?? routing.name) : routing.name, journey, result);
      learnFromJourney(journey, result);
    } catch {
      /* best effort */
    }
    if (variant === "primary") primaryCount++;
    else fallbackCount++;
    return result;
  };

  // ---- 1) Seed from cache: union of ALL prior results for this route+date
  // (any mode / time window), so switching modes or re-running accumulates
  // instead of refetching/dropping what we already have. (stale-while-revalidate)
  const seedPrefix = `${params.originKey ?? params.originId ?? "?"}|${params.destKey ?? params.destId ?? "?"}|${params.travelDate}|`;
  const seedRows = db
    .select()
    .from(journeyQueries)
    .where(like(journeyQueries.cacheKey, `${seedPrefix}%`))
    .all();
  const seedFps = new Set<string>();
  let seedCachedAt: number | null = null;
  let seedStale = true;
  for (const row of seedRows) {
    for (const fp of row.resultFingerprints) seedFps.add(fp);
    seedCachedAt = Math.max(seedCachedAt ?? 0, row.lastRunAt);
    if (row.expiresAt >= now()) seedStale = false;
  }
  if (seedFps.size) {
    for (const r of loadResults([...seedFps])) if (!collected.has(r.fingerprint)) collected.set(r.fingerprint, r);
    for (const r of collected.values()) setAnchor(r.coverage.price);
    const seeded = snapshot();
    if (seeded.length) {
      emit({ type: "cached", results: seeded, meta: { ...meta(), stale: seedStale, cachedAt: seedCachedAt } });
    }
  }
  if (params.restoreOnly) {
    dlog("search", "restoreOnly", { seeded: collected.size });
    emit({ type: "done", results: snapshot(), meta: { ...meta(), cachedAt: seedCachedAt } });
    return;
  }

  const abort = () => signal?.aborted;

  dlog("search", "start", {
    mode: params.mode,
    origin: params.originKey ?? params.originId,
    dest: params.destKey ?? params.destId,
    date: params.travelDate,
    window: params.timeWindow,
    routing: routing.name,
    pricing: pricing?.name ?? "off",
  });

  try {
    const originEndpoints = await getEndpoints(params, "origin", () => motisUsed++);
    const destEndpoints = await getEndpoints(params, "dest", () => motisUsed++);
    const dest = destEndpoints[0];
    if (!originEndpoints.length || !dest) {
      throw new Error("Start- oder Zielhaltestelle konnte nicht aufgelöst werden.");
    }
    const primaryOrigin = originEndpoints[0];
    const perMode = params.mode === "fast" ? 4 : params.mode === "thorough" ? 6 : 8;

    // ---- DB pricing (anchor + normal + pro-forma), shared across passes ----
    let dbOrigin: string | null | undefined;
    let dbDest: string | null | undefined;
    const pricingOpts = {
      klasse: prefs.klasse,
      bahncard: prefs.bahncard,
      deutschlandTicket: prefs.deutschlandTicket,
    };
    const expected = { fromName: primaryOrigin.name, toName: dest.name };

    const resolveDb = async (name: string): Promise<string | null> => {
      const key = normStationName(name);
      if (dbIdCache.has(key)) return dbIdCache.get(key)!;
      onDbUse();
      try {
        await jitter();
        const hits = await pricing!.searchLocations(name, { results: 3 });
        const id = hits[0]?.id ?? null;
        dbIdCache.set(key, id);
        return id;
      } catch {
        dbIdCache.set(key, null);
        return null;
      }
    };

    const ensureDbEndpoints = async (): Promise<boolean> => {
      if (dbOrigin === undefined) dbOrigin = await resolveDb(primaryOrigin.name);
      if (dbDest === undefined) dbDest = await resolveDb(dest.name);
      return !!(dbOrigin && dbDest);
    };

    // Phase-1 reference: the NORMAL connection at the desired time (what you'd book).
    const priceNormalOnly = async () => {
      if (!dbOrigin || !dbDest || !pricing || !canSpend()) return;
      onDbUse();
      onPriced();
      try {
        await jitter();
        const res = await pricing.searchJourneys(dbOrigin, dbDest, {
          ...timeOpt,
          results: 5,
          tickets: true,
          products: productFilter(params.filters),
          ...pricingOpts,
          signal,
        });
        for (const j of res.journeys) {
          setAnchor(j.price?.amount);
          ingest(j, "primary", primaryOrigin.label, "candidate", expected, "normal");
        }
        dlog("search", `normal journeys: ${res.journeys.length}, reference≈${anchorPrice ?? "–"}€`);
      } catch (err) {
        if (err instanceof ProviderError && (err.isBlocked || err.status === 503)) {
          emit({ type: "status", message: "DB-Preisquelle nicht erreichbar – Fahrplan wird angezeigt.", meta: meta() });
        }
      }
    };

    // Cheaper alternatives: avoid ICE (IC + regional) → smaller/cheaper FV.
    const priceLowFv = async () => {
      if (!dbOrigin || !dbDest || !pricing || !canSpend()) return;
      onDbUse();
      onPriced();
      try {
        await jitter();
        const res = await pricing.searchJourneys(dbOrigin, dbDest, {
          ...timeOpt,
          results: 5,
          tickets: true,
          products: {
            nationalExpress: false,
            national: true,
            regionalExpress: true,
            regional: true,
            suburban: true,
            subway: true,
            tram: true,
            bus: true,
            ferry: true,
            taxi: true,
          },
          ...pricingOpts,
          signal,
        });
        // Low-FV connections are bookable DB journeys, but from a constructed
        // search (ICE excluded) — no "Pro-Forma" badge, yet not a DB original.
        for (const j of res.journeys) ingest(j, "primary", primaryOrigin.label, "candidate", expected, "alternative");
        dlog("search", `low-FV journeys: ${res.journeys.length}`);
      } catch {
        /* best effort */
      }
    };

    // Stage 2: pro-forma candidates, priced concurrently (limiter caps to 3).
    const priceProforma = async () => {
      if (!dbOrigin || !dbDest || !pricing) return;
      const byVia = new Map<string, SearchResult>();
      for (const r of collected.values()) {
        if (r.metrics.fvLegs < 1 || r.coverage.price != null || !r.headlineFv) continue;
        if (!nearAnchor(r)) continue; // don't spend budget off-time
        const viaKey = normStationName(r.headlineFv.fromName);
        if (seenVia.has(viaKey)) continue;
        const prev = byVia.get(viaKey);
        if (!prev || exploitBetter(r, prev)) byVia.set(viaKey, r);
      }
      const unique = [...byVia.values()];
      if (!unique.length) return;
      const obs = observationCounts();
      const selected = selectForPricing(unique, {
        budget: unique.length,
        totalObservations: totalDecisions(),
        observationsOf: (r) => obs.get(segmentSignature(r.headlineFv!)) ?? 0,
      });
      const remaining = alternativesMode ? unique.length : Math.max(0, dbBudget - pricedVias);
      const batchViaKeys: string[] = [];
      const batch = selected.slice(0, remaining).filter((sel) => {
        const viaKey = normStationName(sel.result.headlineFv!.fromName);
        if (seenVia.has(viaKey)) return false;
        seenVia.add(viaKey);
        batchViaKeys.push(viaKey);
        return true;
      });
      // Remember these vias so future searches / "more prices" don't retry them.
      addAttemptedVias(routeKey, batchViaKeys);
      await Promise.all(
        batch.map(async (sel) => {
          if (dailyRemaining() <= 0 || abort()) return;
          const cand = sel.result;
          // Send BOTH endpoints of the observed FV segment as Zwischenhalte
          // (DB Navigator-style multi-via) with a short Aufenthalt at the first,
          // to bias DB toward a single contained Fernverkehr hop A→B.
          const dbViaFrom = await resolveDb(cand.headlineFv!.fromName);
          if (dailyRemaining() <= 0 || abort()) return;
          const dbViaTo = await resolveDb(cand.headlineFv!.toName);
          if (dailyRemaining() <= 0 || abort()) return;
          const viaList = [dbViaFrom, dbViaTo].filter((x): x is string => !!x);
          onDbUse();
          onPriced();
          let observedPrice: number | null = null;
          let coverage = "unpriced";
          try {
            await jitter();
            const when = cand.metrics.plannedDeparture ? new Date(cand.metrics.plannedDeparture) : undefined;
            const res = await pricing.searchJourneys(dbOrigin!, dbDest!, {
              departure: when,
              results: 3,
              ...(viaList.length > 1
                ? { viaList, viaStopMinutes: 5 }
                : { via: dbViaFrom ?? undefined }),
              products: productFilter(params.filters),
              tickets: true,
              ...pricingOpts,
              signal,
            });
            for (const j of res.journeys) {
              if (!j.legs.some((l) => !l.isWalking && isLongDistanceProduct(l.product))) continue;
              // Via-forced routing → bookable DB connection, but not what DB
              // proposes for a plain search: no badge, not "original".
              ingest(j, "primary", primaryOrigin.label, "candidate", expected, "alternative");
              const p = j.price?.amount;
              if (typeof p === "number") {
                observedPrice = observedPrice == null ? p : Math.min(observedPrice, p);
                coverage = "green";
              }
            }
          } catch (err) {
            if (err instanceof ProviderError && (err.isBlocked || err.status === 503)) coverage = "none";
          }
          try {
            logDecision({
              searchRunId: runId,
              travelDate: params.travelDate,
              segment: cand.headlineFv!,
              reason: sel.reason,
              exploitRank: sel.exploitRank,
              epsilon: sel.epsilon,
              observedPrice,
              coverage,
            });
          } catch {
            /* logging best-effort */
          }
        }),
      );
      emit({ type: "results", results: snapshot(), meta: meta() });
    };

    // "Echte" Pro-Forma über die bahn.de-Web-API mit PER-ABSCHNITT-Verkehrsmitteln:
    // baue Start → …Hub(s)… → Ziel mit genau EINEM Fernverkehr-Abschnitt + Rest
    // Nahverkehr als ein buchbares Sparpreis-Ticket (der mydealz-Trick). Kandidaten
    // sind die beobachteten FV-Segmente (A→B) der bisherigen Ergebnisse.
    const truePfTried = new Set<string>();
    const priceTrueProforma = async () => {
      // Uses the bahn.de-Web endpoint directly (not the pricing provider), so only
      // run it with the real impersonating provider — skip for mock/gateway/tests.
      if (pricing?.name !== "dbvendo") return;
      if (!canSpend() || abort()) return;
      const originN = normStationName(primaryOrigin.name);
      const destN = normStationName(dest.name);
      // Candidate FV segments A→B: from what we've observed AND the learned graph.
      const segs = new Map<string, { a: string; b: string }>();
      const addSeg = (a?: string, b?: string) => {
        if (!a || !b) return;
        const na = normStationName(a);
        const nb = normStationName(b);
        if (na === nb) return;
        const key = `${na}|${nb}`;
        if (!segs.has(key)) segs.set(key, { a, b });
      };
      for (const r of collected.values()) if (r.headlineFv) addSeg(r.headlineFv.fromName, r.headlineFv.toName);
      for (const e of getInterestingEdges(alternativesMode ? 40 : 20)) addSeg(e.fromName, e.toName);
      // Observed segments (today's real trains) come first, then the learned
      // corridor FV stops from the graph — more hubs = more ICE positions covered.
      const candidates = [...segs.values()].slice(0, alternativesMode ? 10 : 4);
      if (!candidates.length) return;
      emit({ type: "status", message: "Echte Pro-Forma-Preise (1 FV-Abschnitt) …", meta: meta() });
      for (const { a, b } of candidates) {
        if (dailyRemaining() <= 0 || abort()) break;
        const na = normStationName(a);
        const nb = normStationName(b);
        // regional → FV(A→B) → regional, FV(Start→A) → regional, Start → FV(B→Ziel)
        const shapes: { viaNames: string[]; fvAbschnitt: number }[] = [
          { viaNames: [a, b], fvAbschnitt: 1 },
        ];
        if (na !== originN) shapes.push({ viaNames: [a], fvAbschnitt: 0 }); // FV am Anfang
        if (nb !== destN) shapes.push({ viaNames: [b], fvAbschnitt: 1 }); // FV am Ende
        for (const shape of shapes) {
          if (dailyRemaining() <= 0 || abort()) break;
          const sig = `${shape.viaNames.map(normStationName).join(">")}#${shape.fvAbschnitt}`;
          if (truePfTried.has(sig)) continue;
          truePfTried.add(sig);
          onDbUse();
          onPriced();
          try {
            const js = await searchProforma({
              fromName: primaryOrigin.name,
              toName: dest.name,
              viaNames: shape.viaNames,
              fvAbschnitt: shape.fvAbschnitt,
              ...timeOpt,
              klasse: prefs.klasse,
            });
            for (const j of js) {
              if (!j.legs.some((l) => !l.isWalking && isLongDistanceProduct(l.product))) continue;
              ingest(j, "primary", primaryOrigin.label, "candidate", expected, "proforma");
            }
          } catch {
            /* best effort — Akamai/422 handled in the provider */
          }
        }
      }
      emit({ type: "results", results: snapshot(), meta: meta() });
    };

    // THE mydealz trick on YOUR chosen trip: read the reference connection's
    // Fernverkehr run at the reference time, then for each of its stops price a
    // single ticket "regional to the FV boarding → FV up to that stop → regional
    // onward to the destination". Cheaper variants = same first trains, you just
    // leave the ICE/IC earlier and ride regional the rest. No off-time results.
    const getOffTried = new Set<string>();
    const priceGetOffEarlier = async () => {
      if (pricing?.name !== "dbvendo" || !dbOrigin || !dbDest || !canSpend() || abort()) return;
      // 1) Fresh search at the reference time → read the FV leg + its stopovers.
      onDbUse();
      let fvLeg: { origin: { name: string }; stopovers?: { name: string }[] } | null = null;
      try {
        await jitter();
        const res = await pricing.searchJourneys(dbOrigin, dbDest, {
          departure,
          results: 6,
          tickets: true,
          stopovers: true,
          ...pricingOpts,
          signal,
        });
        for (const j of res.journeys) {
          const fv = j.legs.find(
            (l) => !l.isWalking && isLongDistanceProduct(l.product) && (l.stopovers?.length ?? 0) > 0,
          );
          if (fv && (!fvLeg || (fv.stopovers?.length ?? 0) > (fvLeg.stopovers?.length ?? 0))) {
            fvLeg = { origin: { name: fv.origin.name }, stopovers: fv.stopovers };
          }
        }
      } catch {
        return;
      }
      if (!fvLeg) return;
      const boarding = fvLeg.origin.name;
      const stops = (fvLeg.stopovers ?? [])
        .map((s) => s.name)
        .filter((n) => n && n !== "?" && normStationName(n) !== normStationName(boarding));
      const candidates = [...new Set(stops)].slice(0, 10);
      if (!candidates.length) return;
      emit({
        type: "status",
        message: `Prüfe: früher aus dem Fernverkehr aussteigen (${candidates.length} Halte ab ${boarding}) …`,
        meta: meta(),
      });
      let done = 0;
      for (const si of candidates) {
        if (dailyRemaining() <= 0 || abort()) break;
        const sig = `${normStationName(boarding)}>${normStationName(si)}`;
        if (getOffTried.has(sig)) continue;
        getOffTried.add(sig);
        onDbUse();
        onPriced();
        try {
          const js = await searchProforma({
            fromName: primaryOrigin.name,
            toName: dest.name,
            viaNames: [boarding, si], // regional→boarding, FV boarding→si, regional si→dest
            fvAbschnitt: 1,
            departure,
            klasse: prefs.klasse,
          });
          for (const j of js) {
            if (!j.legs.some((l) => !l.isWalking && isLongDistanceProduct(l.product))) continue;
            ingest(j, "primary", primaryOrigin.label, "candidate", expected, "proforma");
          }
        } catch {
          /* best effort */
        }
        if (++done % 3 === 0) emit({ type: "results", results: snapshot(), meta: meta() });
      }
      emit({ type: "results", results: snapshot(), meta: meta() });
    };

    const priceNow = async () => {
      if (!pricing) return;
      if (!canSpend()) {
        if (dailyRemaining() <= 0) {
          emit({
            type: "status",
            message: `Tageslimit für Preisabfragen erreicht (${DB_DAILY_CAP}/Tag) – morgen wieder, oder DB_DAILY_CAP erhöhen.`,
            meta: meta(),
          });
        }
        return;
      }
      if (!(await ensureDbEndpoints())) {
        emit({ type: "status", message: "DB-Preisprüfung nicht möglich (Haltestelle nicht auflösbar).", meta: meta() });
        return;
      }
      if (!anchorDone) {
        anchorDone = true;
        emit({ type: "status", message: "Preise werden geladen (DB) …", meta: meta() });
        await priceNormalOnly();
        await priceLowFv();
        emit({ type: "results", results: snapshot(), meta: meta() });
      }
      if (canSpend()) {
        emit({ type: "status", message: "Günstigere Alternativen werden bepreist (DB) …", meta: meta() });
        await priceProforma();
      }
    };

    // ---- "Mehr Preise laden": reuse cached journeys, skip MOTIS, price the
    // still-unpriced candidates (same route/profile, no new timetable calls) ----
    if (params.morePrices) {
      // collected is already seeded from cache above (accumulation).
      dlog("search", "morePrices: using seeded cache", { count: collected.size });
      emit({ type: "results", results: snapshot(), meta: meta() });
      await priceNow();
      const finalResults = snapshot();
      persistQuery(cacheKey, params, finalResults);
      finishRun(runId, motisUsed + dbUsed, candidatesChecked, finalResults);
      dlog("search", "morePrices done", { results: finalResults.length, dbUsed, pricedVias });
      emit({ type: "done", results: finalResults, meta: meta() });
      return;
    }

    // ---- MOTIS baseline + fallback (schedule + graph). Skipped in phase 2
    // (alternatives) which reuses the cached connections. ----
    if (params.stage !== "alternatives") {
      emit({ type: "status", message: "Fahrplan wird geladen (MOTIS) …", meta: meta() });
      motisUsed++;
      const primaryJourneys = await safeJourneys(routing, primaryOrigin.id, dest.id, {
        ...timeOpt,
        results: perMode,
        products: productFilter(params.filters),
        signal,
      });
      for (const j of primaryJourneys) ingest(j, "primary", primaryOrigin.label, "live");
      dlog("search", `baseline: ${primaryJourneys.length} journeys from ${primaryOrigin.label}`);
      emit({ type: "results", results: snapshot(), meta: meta() });

      const primaryUsable = [...collected.values()].some((r) => r.variant === "primary");
      if (
        shouldTryFallback({
          useFallback: params.filters.useFallback,
          hasFallback: originEndpoints.length > 1,
          primaryUsable,
          mode: params.mode,
          requestsUsed: motisUsed,
          budget: motisBudget,
        }) &&
        !abort()
      ) {
        const fb = originEndpoints[1];
        emit({ type: "status", message: `Prüfe Alternative ab ${fb.label} …`, meta: meta() });
        motisUsed++;
        const fbJourneys = await safeJourneys(routing, fb.id, dest.id, {
          ...timeOpt,
          results: perMode,
          products: productFilter(params.filters),
          signal,
        });
        for (const j of fbJourneys) ingest(j, "fallback", fb.label, "live");
        emit({ type: "results", results: snapshot(), meta: meta() });
      }
    }

    // ---- Pricing, by phase ----
    if (!pricing) {
      emit({
        type: "status",
        message: "Preisprüfung nicht verfügbar – Fahrplanergebnisse werden angezeigt (Preis nicht geprüft).",
        meta: meta(),
      });
    } else if (!(await ensureDbEndpoints())) {
      emit({ type: "status", message: "DB-Preisprüfung nicht möglich (Haltestelle nicht auflösbar).", meta: meta() });
    } else if (dailyRemaining() <= 0) {
      emit({ type: "status", message: `Tageslimit für Preisabfragen erreicht – Fahrplan wird ohne Preis angezeigt.`, meta: meta() });
    } else if (params.stage === "normal") {
      // Phase 1: only the normal reference connections. You then pick a reference.
      emit({ type: "status", message: "Normale Verbindungen werden bepreist (DB) …", meta: meta() });
      await priceNormalOnly();
      emit({ type: "results", results: snapshot(), meta: meta() });
    } else if (params.stage === "alternatives") {
      // Phase 2: cheaper minimal-FV alternatives (low-FV pass; pro-forma below).
      emit({ type: "status", message: "Günstigere Alternativen werden gesucht (DB) …", meta: meta() });
      await priceLowFv();
      emit({ type: "results", results: snapshot(), meta: meta() });
    } else {
      await priceNow();
    }

    // ---- 5) MOTIS candidate exploration (thorough/deep full searches only).
    // Skipped in phase 1 (normal) AND in phase 2 (alternatives): a reference
    // search must keep the SAME leading trains, so broad exploration at other
    // hubs/times only produces connections the prefix filter discards — the
    // pro-forma passes (at the reference time) yield the matching alternatives.
    if (
      params.stage !== "normal" &&
      !alternativesMode &&
      (params.mode === "thorough" || params.mode === "deep") &&
      !abort()
    ) {
      const edges = getInterestingEdges(params.mode === "deep" || alternativesMode ? 60 : 25).filter(
        (e) => e.fromLocationId && isLongDistanceProduct(e.product),
      );
      const slots: Date[] = alternativesMode
        ? // Phase 2: search exactly at the reference departure — alternatives must
          // board the SAME first trains, so later slots would only be filtered out.
          [departure]
        : arriveBy
          ? // Arrival mode: "arrive by" the window end (deep: also 3 h earlier).
            params.mode === "deep"
            ? [arriveBy, new Date(arriveBy.getTime() - 3 * 3600_000)]
            : [arriveBy]
          : params.mode === "deep"
            ? [departure, new Date(departure.getTime() + 3 * 3600_000)]
            : [departure];
      const jobs: { via: string; when: Date }[] = [];
      for (const when of slots) for (const e of edges) jobs.push({ via: e.fromLocationId!, when });
      candidatesTotal = Math.max(0, Math.min(jobs.length, motisBudget - motisUsed));
      if (candidatesTotal > 0) {
        emit({ type: "status", message: `Suche ${candidatesTotal} Fernverkehrs-Kombinationen (MOTIS) …`, meta: meta() });
      }
      for (const job of jobs) {
        if (abort() || motisUsed >= motisBudget) break;
        candidatesChecked++;
        motisUsed++;
        const viaJourneys = await safeJourneys(routing, primaryOrigin.id, dest.id, {
          ...(arriveBy ? { arrival: job.when } : { departure: job.when }),
          results: 3,
          via: job.via,
          products: productFilter(params.filters),
          signal,
        }).catch(() => []);
        for (const j of viaJourneys) {
          if (!j.legs.some((l) => !l.isWalking && isLongDistanceProduct(l.product))) continue;
          ingest(j, "primary", primaryOrigin.label, "live");
        }
        const prices = [...collected.values()].map((r) => r.metrics.fvMinutes);
        emit({
          type: "progress",
          checked: candidatesChecked,
          total: candidatesTotal,
          bestPrice: meta().bestPrice,
          bestFvMinutes: prices.length ? Math.min(...prices) : null,
        });
        if (candidatesChecked % 4 === 0) emit({ type: "results", results: snapshot(), meta: meta() });
      }
    }

    // ---- 6) Price the discovered candidates (not in phase 1) ----
    if (params.stage !== "normal" && pricing && canSpend() && !abort()) {
      if (params.stage === "alternatives") {
        // Phase 2 (reference chosen): THE trick on your own trip — leave the FV
        // earlier at each of its stops and ride regional onward. Then the learned
        // per-Abschnitt segments as a backstop. Both price at the reference time,
        // so results keep your exact leading trains.
        await priceGetOffEarlier();
        await priceTrueProforma();
      } else if (params.mode === "thorough" || params.mode === "deep") {
        await priceNow();
        await priceTrueProforma();
      }
    }

    // ---- Resolve bahn.de station ids for a working "Bei DB prüfen" link ----
    // (current bahn.de needs soid/soei; station names alone error out.)
    if (pricing?.name === "dbvendo" && !abort()) {
      const names = new Set<string>();
      for (const r of collected.values()) {
        names.add(r.metrics.originName);
        names.add(r.metrics.destinationName);
      }
      await Promise.all(
        [...names].map(async (name) => {
          if (stationIds[name]) return;
          try {
            const rich = await resolveRichId(name);
            const eva = rich?.match(/@L=(\d+)@/)?.[1];
            if (rich && eva) stationIds[name] = { soid: rich, soei: eva };
          } catch {
            /* best effort */
          }
        }),
      );
    }

    // ---- 7) Finalize ----
    const finalResults = snapshot();
    persistQuery(cacheKey, params, finalResults);
    finishRun(runId, motisUsed + dbUsed, candidatesChecked, finalResults);
    dlog("search", "done", {
      results: finalResults.length,
      motisUsed,
      dbUsed,
      pricedVias,
      green: finalResults.filter((r) => r.coverage.coverage === "green").length,
    });
    emit({ type: "done", results: finalResults, meta: meta() });
  } catch (err) {
    const isProvider = err instanceof ProviderError;
    const results = snapshot();
    dlog("search", "ERROR", {
      isProvider,
      status: (err as { status?: number }).status,
      message: (err as Error).message,
      partial: results.length,
    });
    finishRun(runId, motisUsed + dbUsed, candidatesChecked, results, "error");
    emit({
      type: "error",
      message: isProvider
        ? "Die Fahrplan-Datenquelle antwortet gerade nicht. Es werden – falls vorhanden – die zuletzt gespeicherten Ergebnisse angezeigt."
        : (err as Error).message,
      results,
      meta: meta(),
    });
  }
}


function exploitBetter(a: SearchResult, b: SearchResult): boolean {
  return (
    a.metrics.fvStops - b.metrics.fvStops ||
    a.metrics.fvMinutes - b.metrics.fvMinutes ||
    a.metrics.transfers - b.metrics.transfers ||
    a.metrics.durationMin - b.metrics.durationMin
  ) < 0;
}

function betterCoverage(a: SearchResult, b: SearchResult): boolean {
  const rank = { green: 4, yellow: 3, unpriced: 2, red: 1, none: 0 } as const;
  if (rank[a.coverage.coverage] !== rank[b.coverage.coverage])
    return rank[a.coverage.coverage] > rank[b.coverage.coverage];
  return (a.coverage.price ?? Infinity) < (b.coverage.price ?? Infinity);
}

async function getEndpoints(
  params: SearchParams,
  which: "origin" | "dest",
  countReq: () => void,
): Promise<Endpoint[]> {
  const key = which === "origin" ? params.originKey : params.destKey;
  if (key) {
    const profile = getProfile(key);
    if (profile) {
      const resolved = await resolveEndpoints(profile, countReq);
      if (resolved.length) return resolved;
      return searchableStations(profile).map((s) => ({
        id: s.locationId!,
        name: s.stationName,
        label: shortLabel(s.stationName, profile.stations.map((x) => x.stationName)),
        variant: s.priority === 0 ? "primary" : ("fallback" as const),
      }));
    }
  }
  const id = which === "origin" ? params.originId : params.destId;
  const name = (which === "origin" ? params.originName : params.destName) ?? "";
  if (id) return [{ id, name, label: shortLabel(name, []), variant: "primary" }];
  return [];
}

async function safeJourneys(
  provider: RailProvider,
  from: string,
  to: string,
  opts: Parameters<RailProvider["searchJourneys"]>[2],
): Promise<NormJourney[]> {
  // The routing source (MOTIS/Transitous) is occasionally flaky — a single
  // failed call would otherwise empty the whole search. Retry with backoff so
  // transient outages don't kill an entire result set.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (opts?.signal?.aborted) break;
    try {
      const res = await provider.searchJourneys(from, to, opts);
      return res.journeys;
    } catch (err) {
      lastErr = err;
      if (opts?.signal?.aborted) break;
      if (attempt < 2) {
        dlog("search", `routing retry ${attempt + 1}/2`, { err: (err as Error).message });
        await new Promise((r) => setTimeout(r, 500 + attempt * 1200));
      }
    }
  }
  throw lastErr;
}

function persistQuery(cacheKey: string, params: SearchParams, results: SearchResult[]): void {
  const ts = now();
  const fps = results.map((r) => r.fingerprint);
  db.insert(journeyQueries)
    .values({
      id: newId("jq"),
      cacheKey,
      originId: params.originId ?? null,
      destinationId: params.destId ?? null,
      travelDate: params.travelDate,
      timeWindow: params.timeWindow,
      direction: "dep",
      passengers: 1,
      bahncard: null,
      searchMode: params.mode,
      provider: getRoutingProvider().name,
      resultFingerprints: fps,
      createdAt: ts,
      lastRunAt: ts,
      expiresAt: ts + TTL.journeySearch,
    })
    .onConflictDoUpdate({
      target: journeyQueries.cacheKey,
      set: { resultFingerprints: fps, lastRunAt: ts, expiresAt: ts + TTL.journeySearch },
    })
    .run();
}

function finishRun(
  runId: string,
  requestsUsed: number,
  candidatesChecked: number,
  results: SearchResult[],
  status: "done" | "error" = "done",
): void {
  const prices = results.map((r) => r.coverage.price).filter((p): p is number => p != null);
  db.update(searchRuns)
    .set({
      finishedAt: now(),
      requestsUsed,
      candidatesChecked,
      resultsFound: results.length,
      bestPrice: prices.length ? Math.min(...prices) : null,
      status,
    })
    .where(eq(searchRuns.id, runId))
    .run();
}
