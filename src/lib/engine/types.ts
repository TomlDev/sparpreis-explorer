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
};

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
