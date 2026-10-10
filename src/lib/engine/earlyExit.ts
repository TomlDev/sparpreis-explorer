import { like } from "drizzle-orm";
import { db } from "@/db/client";
import { journeyQueries } from "@/db/schema";
import { buildResult, type SearchResult } from "@/lib/domain/result";
import { normStationName } from "@/lib/domain/ticketCoverage";
import type { NormJourney } from "@/lib/rail/types";
import { loadJourney, loadResults } from "@/lib/repo/journeys";
import { getProfile } from "@/lib/routeProfiles";
import type { SearchParams } from "./types";

/**
 * "Früher aussteigen": DB lets you end the trip early. A ticket found for a
 * farther destination (e.g. Schwarzwald) whose trains stop at this one (e.g.
 * Freiburg Hbf) is a ticket for here too — at its price, often cheaper than a
 * direct one. Taken from the stored searches with the same start and day, no
 * DB requests.
 */
export function deriveEarlyExit(r: SearchResult, journey: NormJourney, destNames: string[]): SearchResult | null {
  const target = new Set(destNames.map(normStationName).filter(Boolean));
  if (!target.size || r.coverage.coverage !== "green" || r.coverage.price == null) return null;
  if (target.has(normStationName(r.metrics.destinationName))) return null; // already ends there
  const k = journey.legs.findIndex((l) => !l.isWalking && target.has(normStationName(l.destination.name)));
  if (k < 0 || k === journey.legs.length - 1) return null;
  // the ticket must still be valid on the train arriving here
  if (r.coverage.uncoveredLegs?.includes(k)) return null;
  const base = buildResult(
    { ...journey, legs: journey.legs.slice(0, k + 1), ticketInfo: null },
    { source: "cache", priceCheckedAt: r.priceCheckedAt, timetableAt: r.timetableAt, resultKind: r.resultKind },
  );
  return {
    ...base,
    fingerprint: `${base.fingerprint}-x${r.fingerprint.slice(0, 8)}`,
    coverage: {
      ...r.coverage,
      uncoveredLegs: r.coverage.uncoveredLegs?.filter((i) => i <= k),
      reason: `Ticket bis ${r.metrics.destinationName} – du steigst in ${journey.legs[k].destination.name} aus`,
    },
    priceHow: r.priceHow,
    earlyExit: {
      ticketFrom: r.metrics.originName,
      ticketTo: r.metrics.destinationName,
      fvFrom: r.headlineFv?.fromName ?? null,
      fvTo: r.headlineFv?.toName ?? null,
      fvLegs: r.metrics.fvLegs,
      baseFingerprint: base.fingerprint,
    },
  };
}

/** Early-exit results for this search from the other destinations searched for the same start and day. */
export function earlyExitResults(params: SearchParams): SearchResult[] {
  const origin = params.originKey ?? params.originId;
  const dest = params.destKey ?? params.destId;
  if (!origin || !dest) return [];
  const profile = params.destKey ? getProfile(params.destKey) : null;
  const destNames = profile ? profile.stations.map((s) => s.stationName) : [params.destName ?? ""];
  const fps = new Set<string>();
  for (const q of db.select({ cacheKey: journeyQueries.cacheKey, fps: journeyQueries.resultFingerprints }).from(journeyQueries).where(like(journeyQueries.cacheKey, `${origin}|%`)).all()) {
    const [o, d, date] = q.cacheKey.split("|");
    if (o === origin && d !== dest && date === params.travelDate) for (const fp of q.fps ?? []) fps.add(fp);
  }
  if (!fps.size) return [];
  const best = new Map<string, SearchResult>();
  for (const r of loadResults([...fps])) {
    const journey = loadJourney(r.fingerprint);
    const e = journey ? deriveEarlyExit(r, journey, destNames) : null;
    if (!e?.earlyExit) continue;
    const key = e.earlyExit.baseFingerprint;
    const prev = best.get(key);
    if (!prev || (e.coverage.price ?? Infinity) < (prev.coverage.price ?? Infinity)) best.set(key, e);
  }
  return [...best.values()];
}
