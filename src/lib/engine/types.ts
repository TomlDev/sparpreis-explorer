import type { SearchMode } from "@/lib/config";
import type { SortMode } from "@/lib/domain/ranking";
import type { SearchResult } from "@/lib/domain/result";

export interface SearchFilters {
  onlyFullTicket: boolean;
  onlyPriced: boolean;
  requireFv: boolean; // at least one ICE/IC segment
  maxFvLegs: number | null; // at most N Fernverkehr segments (1 = a single ICE)
  belowReference: boolean; // only show alternatives cheaper than the reference price
  onlyOriginal: boolean; // only what DB proposes for a plain search (resultKind "normal"/"anchor")
  allowICE: boolean;
  allowIC: boolean;
  maxPrice: number | null;
  maxDurationMin: number | null;
  maxTransfers: number | null;
  maxFvMinutes: number | null;
  maxFvStops: number | null;
  useFallback: boolean;
  allowSlow: boolean;
  minTransferMin: number | null;
  /** Only connections with at least this % chance of ≥ 20 min delay (punctuality data). */
  minFlexPct: number | null;
  /** Highest acceptable chance (%) that every transfer holds — low = likely to break. */
  maxOkPct: number | null;
}

export const DEFAULT_FILTERS: SearchFilters = {
  onlyFullTicket: true,
  onlyPriced: true,
  requireFv: true,
  maxFvLegs: 0, // 0 = unbegrenzt
  belowReference: true,
  onlyOriginal: false,
  allowICE: true,
  allowIC: true,
  maxPrice: null,
  maxDurationMin: null,
  maxTransfers: null,
  maxFvMinutes: null,
  maxFvStops: null,
  useFallback: true,
  allowSlow: true,
  minTransferMin: null,
  minFlexPct: null,
  maxOkPct: null,
};

/** Limits that can be switched off for a moment without losing the value typed in. */
export const LIMIT_KEYS = [
  "maxPrice",
  "minFlexPct",
  "maxOkPct",
  "maxFvLegs",
  "maxDurationMin",
  "maxTransfers",
  "maxFvMinutes",
  "maxFvStops",
  "minTransferMin",
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];
/** Switched-off filters: limit keys, "belowReference" / "onlyOriginal", or "all" (everything at once). */
export type FilterOff = string[];

/** The filters actually applied: switched-off limits count as "no limit", switched-off
 *  switches as off. "all" = show everything except what never makes sense (no ticket, no FV). */
export function activeFilters(f: SearchFilters, off: FilterOff): SearchFilters {
  if (!off.length) return f;
  const all = off.includes("all");
  const out = { ...f } as Record<string, unknown>;
  for (const k of LIMIT_KEYS) if (all || off.includes(k)) out[k] = k === "maxFvLegs" ? 0 : null;
  for (const k of ["belowReference", "onlyOriginal"]) if (all || off.includes(k)) out[k] = false;
  return out as unknown as SearchFilters;
}

export interface SearchParams {
  /** Profile keys (preferred) — resolve to primary + fallback stations. */
  originKey?: string;
  destKey?: string;
  /** Or explicit ad-hoc endpoints. */
  originId?: string;
  originName?: string;
  destId?: string;
  destName?: string;

  travelDate: string; // yyyy-MM-dd
  timeWindow: string; // named window or HH:mm — window START (see timeMode)
  /** Window END (HH:mm). In arrival mode the engine searches "arrive by" this. */
  timeTo?: string;
  /** Whether the time window means departure (default) or arrival. */
  timeMode?: "departure" | "arrival";
  mode: SearchMode;
  sort: SortMode;
  filters: SearchFilters;
  /** Restore cached results only — no live MOTIS/DB calls (used on reload). */
  restoreOnly?: boolean;
  /** Price more: reuse cached journeys, skip MOTIS, price still-unpriced ones. */
  morePrices?: boolean;
  /**
   * Two-phase flow:
   *  - "normal"       phase 1: show the normal bookable connections (reference candidates)
   *  - "alternatives" phase 2: fetch ALL cheaper minimal-FV alternatives below the reference
   *  - "full"         (default) everything in one pass
   */
  stage?: "normal" | "alternatives" | "full";
  /** Reference price (phase 2): only alternatives cheaper than this are relevant. */
  referencePrice?: number | null;
  /** One time slot of a whole-day scan: boarding stations already priced at
   *  other times of the day are priced again (different trains, other price). */
  daySlot?: boolean;
}

export interface SearchMeta {
  stale: boolean;
  cachedAt: number | null;
  // routing (MOTIS) side
  routingProvider: string;
  routingReachable: boolean;
  motisUsed: number;
  motisBudget: number;
  // pricing (DB) side
  pricingProvider: string | null;
  priceCheckAvailable: boolean;
  dbUsed: number;
  dbBudget: number;
  pricedCount: number;
  /** cheapest DB best price for the day (the reference "normal" fare). */
  anchorPrice: number | null;
  /** true when the daily DB price-check cap is reached (no more live pricing today). */
  dailyCapReached: boolean;
  /** DB requests of this run refused by DB's bot protection (HTTP 403) — results / prices incomplete. */
  dbRefused?: number;
  /** The open timetable (MOTIS / Transitous) has no regional trains on that day yet – e.g. right after
   *  the timetable change in December. Only DB's own connections are searched then. */
  timetableGap?: boolean;
  /** unpriced candidates whose via hasn't been tried yet — genuinely priceable. */
  priceableRemaining: number;
  // progress
  candidatesChecked: number;
  candidatesTotal: number;
  primaryCount: number;
  fallbackCount: number;
  bestPrice: number | null;
  originVariants: { label: string; count: number }[];
  /** bahn.de station ids (rich soid + EVA soei) keyed by exact station name,
   *  for building a working "Bei DB prüfen" deep link. */
  stationIds: Record<string, { soid: string; soei: string }>;
}

export type SearchEvent =
  | { type: "cached"; results: SearchResult[]; meta: SearchMeta }
  | { type: "status"; message: string; meta?: Partial<SearchMeta> }
  | {
      type: "progress";
      checked: number;
      total: number;
      bestPrice: number | null;
      bestFvMinutes: number | null;
    }
  | { type: "results"; results: SearchResult[]; meta: SearchMeta }
  | { type: "done"; results: SearchResult[]; meta: SearchMeta }
  | { type: "error"; message: string; results: SearchResult[]; meta: SearchMeta };

export type Emit = (event: SearchEvent) => void;

export type { SearchMode, SortMode };
