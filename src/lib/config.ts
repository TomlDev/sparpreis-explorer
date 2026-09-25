/**
 * Central configuration: cache TTLs, search budgets, product classes, ranking
 * weights. Everything tunable lives here so behaviour can be adjusted in one
 * place (see the spec section "Die genauen Werte zentral konfigurierbar machen").
 */

export const TIMEZONE = "Europe/Berlin";

/** Cache TTLs in milliseconds. Different kinds of data go stale at very
 *  different rates: a timetable can still be valid while a Sparpreis changed. */
export const TTL = {
  /** Provider location IDs are extremely stable. */
  location: 90 * 24 * 60 * 60 * 1000, // 90 days
  /** Long-term route knowledge (which stops a train serves). */
  tripPattern: 30 * 24 * 60 * 60 * 1000, // 30 days
  /** Concrete timetable structure for a given day. */
  timetable: 3 * 24 * 60 * 60 * 1000, // 3 days
  /** A journey search result set. */
  journeySearch: 30 * 60 * 1000, // 30 minutes
  /** Sparpreis / ticket offers. */
  price: 2 * 60 * 60 * 1000, // 2 hours
  /** Realtime data (delays). */
  realtime: 90 * 1000, // 90 seconds
  /** Negative / error responses — retry soon but not hammering. */
  error: 3 * 60 * 1000, // 3 minutes
} as const;

export type CacheKind = keyof typeof TTL;

/** Per-mode MOTIS routing budget (cheap, cacheable — generous). */
export const MOTIS_BUDGET = {
  fast: 12,
  thorough: 45,
  deep: 110,
} as const;

/** Per-mode DB pricing budget (scarce resource — small).
 *  Only the best pre-ranked candidates get a real price check. */
export const DB_BUDGET = {
  fast: 8,
  thorough: 22,
  deep: 45,
} as const;

/** Hard cap on DB price requests per calendar day (Europe/Berlin), across all
 *  searches. Keeps total volume unobtrusive (looks like a normal user). */
export const DB_DAILY_CAP = Number(process.env.DB_DAILY_CAP || 800);

/** Random human-like delay (ms) added before each DB network call. */
export const DB_JITTER_MS = { min: 150, max: 650 } as const;

/**
 * Candidate-pricing strategy (explore/exploit). Early on the tool knows little,
 * so it explores more (higher epsilon) to discover cheap short FV segments;
 * as observations accumulate, epsilon decays toward the floor and it exploits
 * the proven-cheap short segments. Every decision + outcome is logged.
 */
export const PRICE_STRATEGY = {
  exploreBase: 0.6, // initial exploration probability
  exploreFloor: 0.15, // never explore less than this
  calibrationObservations: 400, // ~observations until epsilon reaches the floor
} as const;

export type SearchMode = keyof typeof MOTIS_BUDGET;

/** Rate limiter behaviour for the (unofficial) DB endpoints. Be defensive. */
export const RATE_LIMIT = {
  /** Max concurrent live requests. */
  concurrency: 3,
  /** Minimum spacing between the start of two requests (ms). */
  minSpacingMs: 350,
  maxRetries: 3,
  baseBackoffMs: 800,
  maxBackoffMs: 15_000,
  /** After this many consecutive hard failures, pause the provider. */
  circuitThreshold: 4,
  circuitCooldownMs: 60_000,
} as const;

/**
 * Product classification. db-vendo-client / hafas product identifiers.
 * Long-distance (Fernverkehr) = the products we actively want a *small* slice of.
 */
export const LONG_DISTANCE_PRODUCTS = new Set([
  "nationalExpress", // ICE
  "national", // IC / EC
]);

/** Human labels for products (German). */
export const PRODUCT_LABELS: Record<string, string> = {
  nationalExpress: "ICE",
  national: "IC/EC",
  regionalExpress: "RE",
  regional: "RB",
  suburban: "S-Bahn",
  subway: "U-Bahn",
  tram: "STR",
  bus: "Bus",
  ferry: "Fähre",
  taxi: "Ruftaxi",
};

/** Ranking weights for the default "Pro-Forma" sort. Lower score = better. */
export const RANKING = {
  /** Big penalty if the ticket does not cover the whole route. */
  noFullTicketPenalty: 100_000,
  /** Penalty if coverage is merely uncertain. */
  uncertainTicketPenalty: 5_000,
  /** Penalty for schedule-only results (price not yet checked). Worse than a
   *  confirmed uncertain price, better than a proven partial fare. */
  unpricedPenalty: 20_000,
  pricePerEuro: 100,
  perFvMinute: 8,
  perFvStop: 250,
  perFvLeg: 120,
  perTransfer: 15,
  perDurationMinute: 0.5,
  perDeviationMinute: 0.3,
} as const;

export type ProviderName = "dbvendo" | "dbrest" | "mock";

export function envProvider(): ProviderName {
  const v = (process.env.RAIL_PROVIDER || "dbvendo").toLowerCase();
  if (v === "mock") return "mock";
  if (v === "dbrest") return "dbrest";
  return "dbvendo";
}

/** Routing (timetable/graph) provider. MOTIS by default; mock for tests/dev. */
export type RoutingProviderName = "motis" | "mock";
export function routingProviderName(): RoutingProviderName {
  const v = (process.env.ROUTING_PROVIDER || "").toLowerCase();
  if (v === "motis") return "motis";
  if (v === "mock") return "mock";
  // Legacy fallback: RAIL_PROVIDER=mock forces the whole stack offline.
  if ((process.env.RAIL_PROVIDER || "").toLowerCase() === "mock") return "mock";
  return "motis";
}

/** Pricing (Sparpreis/ticket) mode. */
export type PricingMode = "gateway" | "direct" | "dbrest" | "mock" | "off";
export function pricingMode(): PricingMode {
  const v = (process.env.DB_VENDO_MODE || "").toLowerCase();
  if (v === "gateway" || v === "direct" || v === "dbrest" || v === "mock" || v === "off") return v;
  // Legacy fallback: RAIL_PROVIDER=mock -> price via mock too (tests).
  if ((process.env.RAIL_PROVIDER || "").toLowerCase() === "mock") return "mock";
  // No explicit config: pricing off (schedule-only) until a gateway is set up.
  return "off";
}

export function userAgent(): string {
  return (
    process.env.RAIL_USER_AGENT ||
    "bahn-finder (self-hosted personal tool)"
  );
}
