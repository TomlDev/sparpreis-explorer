import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * The knowledge store. Two conceptual layers (see spec "Zwei Ebenen"):
 *  - Route knowledge: long-lived (locations, trip_patterns, long_distance_edges,
 *    hub_scores, candidate_patterns) — how the network is shaped.
 *  - Date-specific data: (journeys, ticket_offers, price_snapshots, journey_queries)
 *    — what actually runs and costs on a given day.
 */

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------
export const locations = sqliteTable(
  "locations",
  {
    id: text("id").primaryKey(), // provider location id
    name: text("name").notNull(),
    type: text("type"), // stop | station | poi | address
    lat: real("lat"),
    lng: real("lng"),
    source: text("source").notNull().default("dbvendo"),
    fetchedAt: integer("fetched_at").notNull(),
    lastConfirmedAt: integer("last_confirmed_at").notNull(),
  },
  (t) => ({
    byName: index("loc_name_idx").on(t.name),
  }),
);

// ---------------------------------------------------------------------------
// Route profiles: named endpoints with a primary station + ordered fallbacks
// (e.g. NRW -> Bochum-Langendreer, fallback Bochum Hbf).
// ---------------------------------------------------------------------------
export const routeProfiles = sqliteTable("route_profiles", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(), // "nrw" | "schwarzwald" ...
  label: text("label").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const profileStations = sqliteTable(
  "profile_stations",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => routeProfiles.id, { onDelete: "cascade" }),
    locationId: text("location_id").references(() => locations.id),
    // We keep a snapshot of name/query so the profile survives even before the
    // location id has been resolved/confirmed by the user.
    stationName: text("station_name").notNull(),
    query: text("query"), // original search string
    priority: integer("priority").notNull().default(0), // 0 = primary
    resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
    // Disabled stations stay in the profile but are skipped during search.
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  },
  (t) => ({
    byProfile: index("profstation_profile_idx").on(t.profileId),
  }),
);

// ---------------------------------------------------------------------------
// Trip patterns: long-term "this line usually calls at these stops in order".
// ---------------------------------------------------------------------------
export const tripPatterns = sqliteTable(
  "trip_patterns",
  {
    id: text("id").primaryKey(),
    // A stable signature independent of the concrete date.
    signature: text("signature").notNull().unique(),
    product: text("product").notNull(), // nationalExpress | national | ...
    lineName: text("line_name"), // "ICE 612"
    trainNumber: text("train_number"), // "612"
    operator: text("operator"),
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
    timesSeen: integer("times_seen").notNull().default(1),
  },
  (t) => ({
    byNumber: index("trip_number_idx").on(t.trainNumber),
    byProduct: index("trip_product_idx").on(t.product),
  }),
);

export const tripPatternStops = sqliteTable(
  "trip_pattern_stops",
  {
    id: text("id").primaryKey(),
    patternId: text("pattern_id")
      .notNull()
      .references(() => tripPatterns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    locationId: text("location_id"),
    stationName: text("station_name").notNull(),
    // Minutes from the pattern's first stop (typical, averaged).
    depOffsetMin: integer("dep_offset_min"),
    arrOffsetMin: integer("arr_offset_min"),
  },
  (t) => ({
    byPattern: index("tps_pattern_idx").on(t.patternId),
  }),
);

// ---------------------------------------------------------------------------
// Long-distance edges: adjacent stop pairs on known FV trips. The graph we
// mine for very short ICE/IC segments.
// ---------------------------------------------------------------------------
export const longDistanceEdges = sqliteTable(
  "long_distance_edges",
  {
    id: text("id").primaryKey(),
    signature: text("signature").notNull().unique(), // from|to|product
    fromLocationId: text("from_location_id"),
    fromName: text("from_name").notNull(),
    toLocationId: text("to_location_id"),
    toName: text("to_name").notNull(),
    product: text("product").notNull(),
    typicalDurationMin: integer("typical_duration_min").notNull(),
    stopsBetween: integer("stops_between").notNull().default(0),
    timesSeen: integer("times_seen").notNull().default(1),
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
  },
  (t) => ({
    byFrom: index("lde_from_idx").on(t.fromLocationId),
    byTo: index("lde_to_idx").on(t.toLocationId),
    byProduct: index("lde_product_idx").on(t.product),
    byDuration: index("lde_duration_idx").on(t.typicalDurationMin),
  }),
);

export const edgeTripPatterns = sqliteTable(
  "edge_trip_patterns",
  {
    edgeId: text("edge_id")
      .notNull()
      .references(() => longDistanceEdges.id, { onDelete: "cascade" }),
    patternId: text("pattern_id")
      .notNull()
      .references(() => tripPatterns.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.edgeId, t.patternId] }),
  }),
);

// ---------------------------------------------------------------------------
// Journey queries: cache of (search params) -> result set.
// ---------------------------------------------------------------------------
export const journeyQueries = sqliteTable(
  "journey_queries",
  {
    id: text("id").primaryKey(),
    cacheKey: text("cache_key").notNull().unique(),
    originId: text("origin_id"),
    destinationId: text("destination_id"),
    travelDate: text("travel_date").notNull(), // yyyy-MM-dd (Europe/Berlin)
    timeWindow: text("time_window"), // morning | ... | HH:mm
    direction: text("direction").notNull().default("dep"), // dep | arr
    passengers: integer("passengers").notNull().default(1),
    bahncard: text("bahncard"),
    searchMode: text("search_mode").notNull(),
    provider: text("provider").notNull(),
    // Ordered list of journey fingerprints belonging to this query.
    resultFingerprints: text("result_fingerprints", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    createdAt: integer("created_at").notNull(),
    lastRunAt: integer("last_run_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({
    byExpiry: index("jq_expiry_idx").on(t.expiresAt),
    byDate: index("jq_date_idx").on(t.travelDate),
  }),
);

// ---------------------------------------------------------------------------
// Journeys: normalized, date-specific connections, deduplicated by fingerprint.
// ---------------------------------------------------------------------------
export const journeys = sqliteTable(
  "journeys",
  {
    id: text("id").primaryKey(),
    fingerprint: text("fingerprint").notNull().unique(),
    provider: text("provider").notNull(),
    originId: text("origin_id"),
    originName: text("origin_name").notNull(),
    destinationId: text("destination_id"),
    destinationName: text("destination_name").notNull(),
    travelDate: text("travel_date").notNull(),
    plannedDeparture: text("planned_departure").notNull(), // ISO
    plannedArrival: text("planned_arrival").notNull(), // ISO
    durationMin: integer("duration_min").notNull(),
    transfers: integer("transfers").notNull().default(0),
    // Fernverkehr metrics
    fvMinutes: integer("fv_minutes").notNull().default(0),
    fvStops: integer("fv_stops").notNull().default(0),
    fvLegs: integer("fv_legs").notNull().default(0),
    minTransferMin: integer("min_transfer_min"),
    maxTransferMin: integer("max_transfer_min"),
    deviationMin: integer("deviation_min").notNull().default(0),
    // Full normalized leg array (redundant with journey_legs, for fast reads).
    legsJson: text("legs_json", { mode: "json" }).notNull(),
    // Provider token to refresh price/ticket without re-searching.
    refreshToken: text("refresh_token"),
    // How the journey was found (normal = plain DB search = "original").
    // Null for rows saved before this column existed.
    resultKind: text("result_kind"),
    firstSeen: integer("first_seen").notNull(),
    lastSeen: integer("last_seen").notNull(),
  },
  (t) => ({
    byOrigin: index("j_origin_idx").on(t.originId),
    byDest: index("j_dest_idx").on(t.destinationId),
    byDate: index("j_date_idx").on(t.travelDate),
  }),
);

export const journeyLegs = sqliteTable(
  "journey_legs",
  {
    id: text("id").primaryKey(),
    journeyId: text("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    product: text("product"),
    lineName: text("line_name"),
    trainNumber: text("train_number"),
    originId: text("origin_id"),
    originName: text("origin_name").notNull(),
    destId: text("dest_id"),
    destName: text("dest_name").notNull(),
    plannedDep: text("planned_dep"),
    plannedArr: text("planned_arr"),
    durationMin: integer("duration_min"),
    isLongDistance: integer("is_long_distance", { mode: "boolean" })
      .notNull()
      .default(false),
    isWalking: integer("is_walking", { mode: "boolean" })
      .notNull()
      .default(false),
    stopsCount: integer("stops_count").notNull().default(0),
  },
  (t) => ({
    byJourney: index("jl_journey_idx").on(t.journeyId),
    byTrain: index("jl_train_idx").on(t.trainNumber),
  }),
);

// ---------------------------------------------------------------------------
// Ticket offers: price + coverage assessment, separate from timetable.
// ---------------------------------------------------------------------------
export const ticketOffers = sqliteTable(
  "ticket_offers",
  {
    id: text("id").primaryKey(),
    journeyFingerprint: text("journey_fingerprint").notNull(),
    price: real("price"),
    currency: text("currency").notNull().default("EUR"),
    klasse: integer("klasse").notNull().default(2),
    // coverage: green (full route) | yellow (uncertain) | red (partial)
    coverage: text("coverage").notNull().default("yellow"),
    coverageReason: text("coverage_reason"),
    isFullRoute: integer("is_full_route", { mode: "boolean" })
      .notNull()
      .default(false),
    offerFromName: text("offer_from_name"),
    offerToName: text("offer_to_name"),
    raw: text("raw", { mode: "json" }),
    source: text("source").notNull().default("dbvendo"),
    fetchedAt: integer("fetched_at").notNull(),
    validUntil: integer("valid_until").notNull(),
  },
  (t) => ({
    byFingerprint: index("to_fp_idx").on(t.journeyFingerprint),
    byValid: index("to_valid_idx").on(t.validUntil),
  }),
);

// ---------------------------------------------------------------------------
// Price history snapshots.
// ---------------------------------------------------------------------------
export const priceSnapshots = sqliteTable(
  "price_snapshots",
  {
    id: text("id").primaryKey(),
    journeyFingerprint: text("journey_fingerprint").notNull(),
    travelDate: text("travel_date").notNull(),
    price: real("price"),
    currency: text("currency").notNull().default("EUR"),
    coverage: text("coverage").notNull().default("yellow"),
    observedAt: integer("observed_at").notNull(),
  },
  (t) => ({
    byFp: index("ps_fp_idx").on(t.journeyFingerprint),
    byObserved: index("ps_observed_idx").on(t.observedAt),
  }),
);

// ---------------------------------------------------------------------------
// Candidate patterns: which short FV segments have historically produced
// cheap valid tickets. Checked first on future searches.
// ---------------------------------------------------------------------------
export const candidatePatterns = sqliteTable("candidate_patterns", {
  id: text("id").primaryKey(),
  edgeId: text("edge_id")
    .notNull()
    .references(() => longDistanceEdges.id, { onDelete: "cascade" })
    .unique(),
  numberOfSearches: integer("number_of_searches").notNull().default(0),
  numberOfSuccessfulJourneys: integer("number_of_successful_journeys")
    .notNull()
    .default(0),
  lowestObservedPrice: real("lowest_observed_price"),
  averagePrice: real("average_price"),
  lastSuccessfulDate: text("last_successful_date"),
  score: real("score").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Hub scores: which stations frequently appear on my corridor.
// ---------------------------------------------------------------------------
export const hubScores = sqliteTable("hub_scores", {
  id: text("id").primaryKey(),
  locationId: text("location_id"),
  stationName: text("station_name").notNull().unique(),
  appearances: integer("appearances").notNull().default(0),
  successfulCheapRoutes: integer("successful_cheap_routes").notNull().default(0),
  longDistanceConnections: integer("long_distance_connections")
    .notNull()
    .default(0),
  score: real("score").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Search runs: audit / stats of each executed search.
// ---------------------------------------------------------------------------
export const searchRuns = sqliteTable("search_runs", {
  id: text("id").primaryKey(),
  cacheKey: text("cache_key"),
  mode: text("mode").notNull(),
  travelDate: text("travel_date"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  requestsUsed: integer("requests_used").notNull().default(0),
  budget: integer("budget").notNull().default(0),
  candidatesChecked: integer("candidates_checked").notNull().default(0),
  resultsFound: integer("results_found").notNull().default(0),
  bestPrice: real("best_price"),
  status: text("status").notNull().default("running"), // running|done|aborted|error
});

// ---------------------------------------------------------------------------
// Price decisions: an audit log of every DB price check — which FV segment was
// chosen, why (exploit/explore), and the observed price. Drives learning +
// lets us analyse strategy performance over time.
// ---------------------------------------------------------------------------
export const priceDecisions = sqliteTable(
  "price_decisions",
  {
    id: text("id").primaryKey(),
    searchRunId: text("search_run_id"),
    travelDate: text("travel_date"),
    viaName: text("via_name").notNull(),
    segmentSignature: text("segment_signature").notNull(), // normFrom>normTo>product
    fromName: text("from_name"),
    toName: text("to_name"),
    product: text("product"),
    fvMinutes: integer("fv_minutes").notNull().default(0),
    fvStops: integer("fv_stops").notNull().default(0),
    reason: text("reason").notNull(), // exploit | explore
    exploitRank: integer("exploit_rank"),
    epsilon: real("epsilon"),
    observedPrice: real("observed_price"), // min green price found via this via
    coverage: text("coverage"),
    currency: text("currency").notNull().default("EUR"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    bySegment: index("pd_segment_idx").on(t.segmentSignature),
    byCreated: index("pd_created_idx").on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// Generic provider response cache (raw payloads + negative caching).
// ---------------------------------------------------------------------------
export const providerCache = sqliteTable(
  "provider_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    kind: text("kind").notNull(), // locations|journeys|trip|refresh|departures
    provider: text("provider").notNull(),
    payload: text("payload", { mode: "json" }),
    isError: integer("is_error", { mode: "boolean" }).notNull().default(false),
    errorInfo: text("error_info"),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({
    byExpiry: index("pc_expiry_idx").on(t.expiresAt),
    byKind: index("pc_kind_idx").on(t.kind),
  }),
);

// ---------------------------------------------------------------------------
// Favorites (whole journeys and/or underlying FV segments).
// ---------------------------------------------------------------------------
export const favorites = sqliteTable("favorites", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(), // journey | segment
  label: text("label").notNull(),
  refKey: text("ref_key"), // fingerprint or edge signature
  data: text("data", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// App settings (key/value JSON): default route, feature toggles, etc.
// ---------------------------------------------------------------------------
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// Provider status (circuit breaker / last success), single row per provider.
// ---------------------------------------------------------------------------
export const providerStatus = sqliteTable("provider_status", {
  provider: text("provider").primaryKey(),
  reachable: integer("reachable", { mode: "boolean" }).notNull().default(true),
  lastSuccessAt: integer("last_success_at"),
  lastErrorAt: integer("last_error_at"),
  lastError: text("last_error"),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  pausedUntil: integer("paused_until"),
});

// ---------------------------------------------------------------------------
// Punctuality statistics from open data (piebro/deutsche-bahn-data, CC BY 4.0).
// A "build" = one processing run (button in settings). delay_stats holds
// per-(level,key,station,month,weekday-group) delay histograms; the active
// build is the newest one with status "done".
// ---------------------------------------------------------------------------
export const delayBuilds = sqliteTable("delay_builds", {
  id: text("id").primaryKey(),
  status: text("status").notNull(), // running | done | failed
  params: text("params", { mode: "json" }).notNull(),
  months: text("months", { mode: "json" }).$type<string[]>().notNull(),
  stations: integer("stations").notNull().default(0),
  rows: integer("rows").notNull().default(0),
  error: text("error"),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
});

export const delayStats = sqliteTable(
  "delay_stats",
  {
    buildId: text("build_id").notNull(),
    // train (key = train number) | line_hour (key = "RE2|14") | line (key = "RE2"/"ICE") | station (key = "")
    level: text("level").notNull(),
    key: text("key").notNull(),
    eva: text("eva").notNull(), // EVA number without leading zeros
    month: text("month").notNull(), // yyyy-MM
    dow: text("dow").notNull(), // wk (Mo–Do) | fr | we (Sa/So) | all
    n: integer("n").notNull(),
    cancelled: integer("cancelled").notNull(),
    // Sparse histograms [[minuteBin, count], …]; bins 0..30 per minute, then 38/53/75.
    arrHist: text("arr_hist", { mode: "json" }).$type<[number, number][]>().notNull(),
    depHist: text("dep_hist", { mode: "json" }).$type<[number, number][]>().notNull(),
  },
  (t) => ({
    byLookup: index("delaystats_lookup_idx").on(t.buildId, t.level, t.eva, t.key),
  }),
);

/** Station dictionary of the dataset (name → EVA) for matching our legs by name. */
export const delayStations = sqliteTable(
  "delay_stations",
  {
    buildId: text("build_id").notNull(),
    eva: text("eva").notNull(),
    name: text("name").notNull(),
    norm: text("norm").notNull(), // normalized name (same rule as lib/delay/normalize)
    loose: text("loose").notNull(), // normalized without "(…)" qualifiers, e.g. "Freiburg (Breisgau) Hbf" → "freiburg hbf"
  },
  (t) => ({
    byNorm: index("delaystations_norm_idx").on(t.buildId, t.norm),
    byLoose: index("delaystations_loose_idx").on(t.buildId, t.loose),
  }),
);

// ---------------------------------------------------------------------------
// Travel diary: booked trips, what actually happened, evidence, claims.
// ---------------------------------------------------------------------------
export interface TripLeg {
  product?: string;
  lineName?: string;
  trainNumber?: string;
  fromId?: string | null;
  fromName: string;
  toId?: string | null;
  toName: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  isWalking?: boolean;
  depPlatform?: string | null;
  arrPlatform?: string | null;
}

/** What the ticket itself says (from the DB ticket PDF / booking mail). */
export interface TicketInfo {
  tariff?: string | null; // "Super Sparpreis (Einfache Fahrt)"
  bahncard?: string | null; // "BC25"
  travellers?: string | null; // "1 Person (27-64 Jahre)"
  /** Ticket's own start/destination ("Bochum+City"). */
  from?: string | null;
  to?: string | null;
  /** Trains the ticket is bound to ("ICE 927, 14:49 Uhr am 05.10.2026"). */
  zugbindung?: string[];
  validity?: string | null;
  bookedAt?: string | null;
  traveller?: string | null;
}

export const trips = sqliteTable(
  "trips",
  {
    id: text("id").primaryKey(),
    /** Travel day (yyyy-MM-dd, Europe/Berlin). */
    date: text("date").notNull(),
    originName: text("origin_name").notNull(),
    destName: text("dest_name").notNull(),
    plannedDeparture: text("planned_departure"),
    plannedArrival: text("planned_arrival"),
    legs: text("legs", { mode: "json" }).$type<TripLeg[]>().notNull(),
    // planned | done | delayed | aborted | not_started | cancelled
    status: text("status").notNull().default("planned"),
    // search | pdf | email | db | manual
    source: text("source").notNull().default("manual"),
    fingerprint: text("fingerprint"),
    refreshToken: text("refresh_token"),
    orderNumber: text("order_number"), // DB Auftragsnummer
    price: real("price"),
    klasse: integer("klasse"),
    ticketType: text("ticket_type"), // Sparpreis, Flexpreis, …
    /** Ticket is the outbound or return part of a round trip. */
    direction: text("direction"), // outbound | return
    ticket: text("ticket", { mode: "json" }).$type<TicketInfo>(),
    /** What actually happened. */
    actualArrival: text("actual_arrival"), // ISO, at the ticket's destination
    actualLegs: text("actual_legs", { mode: "json" }).$type<TripLeg[]>(),
    abortedAt: text("aborted_at"), // station where the trip was broken off
    /** Delay announced at the destination when deciding to abort / not travel. */
    expectedDelayMin: integer("expected_delay_min"),
    returnedToStart: integer("returned_to_start", { mode: "boolean" }).notNull().default(false),
    /** Price is for a round-trip ticket (claims use half of it). */
    roundTrip: integer("round_trip", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    byDate: index("trips_date_idx").on(t.date),
    byOrder: index("trips_order_idx").on(t.orderNumber),
  }),
);

export const tripEvents = sqliteTable(
  "trip_events",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // control | note | delay | abort | arrival
    at: integer("at").notNull(), // epoch ms
    lat: real("lat"),
    lng: real("lng"),
    accuracy: real("accuracy"),
    legIndex: integer("leg_index"),
    text: text("text"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ byTrip: index("trip_events_trip_idx").on(t.tripId, t.at) }),
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id").references(() => trips.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // screenshot | ticket | receipt | claim | other
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    path: text("path").notNull(), // relative to data/uploads
    caption: text("caption"),
    takenAt: integer("taken_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ byTrip: index("attachments_trip_idx").on(t.tripId) }),
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    // delay | not_started | aborted_return | aborted_partial | extra_costs
    type: text("type").notNull(),
    status: text("status").notNull().default("draft"), // draft | submitted | paid | rejected
    delayMin: integer("delay_min"),
    amount: real("amount"),
    payout: text("payout").notNull().default("transfer"), // transfer | voucher
    submittedAt: integer("submitted_at"),
    paidAt: integer("paid_at"),
    paidAmount: real("paid_amount"),
    /** DB's case number ("Fall-ID 26V00000001"). */
    caseId: text("case_id"),
    decidedAt: integer("decided_at"),
    /** DB's explanation of the decision. */
    reason: text("reason"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({ byTrip: index("claims_trip_idx").on(t.tripId), byCase: index("claims_case_idx").on(t.caseId) }),
);

export type TripRow = typeof trips.$inferSelect;
export type TripEventRow = typeof tripEvents.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;

export type LocationRow = typeof locations.$inferSelect;
export type JourneyRow = typeof journeys.$inferSelect;
export type JourneyLegRow = typeof journeyLegs.$inferSelect;
export type TicketOfferRow = typeof ticketOffers.$inferSelect;
export type LongDistanceEdgeRow = typeof longDistanceEdges.$inferSelect;
export type TripPatternRow = typeof tripPatterns.$inferSelect;
export type RouteProfileRow = typeof routeProfiles.$inferSelect;
export type ProfileStationRow = typeof profileStations.$inferSelect;
export type CandidatePatternRow = typeof candidatePatterns.$inferSelect;
export type HubScoreRow = typeof hubScores.$inferSelect;
export type FavoriteRow = typeof favorites.$inferSelect;
